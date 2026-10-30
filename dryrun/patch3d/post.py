"""Read an interFoam patch result into twin-ready frames (owner: Eng A)."""

from __future__ import annotations

import io
import re
from pathlib import Path

import numpy as np
from PIL import Image

from dryrun.patch3d.geometry import Patch

_LIST = re.compile(r"nonuniform\s+List<(\w+)>\s*(\d+)\s*\(")
_UNIFORM = re.compile(r"uniform\s+(\([^)]*\)|[-+0-9.eE]+)\s*;")


def _parse_list(txt: str, start: int, kind: str, n: int) -> np.ndarray:
    lines = txt[start:].split("\n", n + 1)
    rows = [ln for ln in lines[: n + 1] if ln.strip()][:n]
    if kind == "scalar":
        return np.array(rows, dtype=float)
    return np.array([r.strip().strip("()").split() for r in rows], dtype=float)


def read_internal(path: Path, ncells: int) -> np.ndarray:
    body = path.read_text()
    body = body[body.index("internalField"):]
    m = _LIST.search(body[:200])
    if m:
        return _parse_list(body, m.end(), m.group(1), int(m.group(2)))
    val = np.array(_UNIFORM.search(body).group(1).strip("()").split(), float)
    return np.repeat(val[None], ncells, 0).squeeze()


def read_patch_values(path: Path, patch: str) -> np.ndarray | None:
    txt = path.read_text()
    bf = txt[txt.index("boundaryField"):]
    m = re.search(r"\n\s*" + re.escape(patch) + r"\s*\n\s*\{", bf)
    if not m:
        return None
    blk = bf[m.end():]
    lm = _LIST.search(blk)
    end = blk.index("}")
    if lm and lm.start() < end:
        return _parse_list(blk, lm.end(), lm.group(1), int(lm.group(2)))
    return None


def _foam_list(path: Path) -> tuple[str, int]:
    txt = path.read_text()
    m = re.search(r"\n(\d+)\s*\n\(", txt)
    return txt[m.end():], int(m.group(1))


def read_mesh(case: Path):
    """points [n,3], faces (list of int arrays), owner [nf], boundary {name: (start, n)}."""
    pm = case / "constant/polyMesh"
    t, n = _foam_list(pm / "points")
    pts = np.array([r.strip("()").split() for r in t.split("\n")[:n]], float)
    t, nf = _foam_list(pm / "faces")
    faces = [np.array(r[r.index("(") + 1:r.index(")")].split(), int) for r in t.split("\n")[:nf]]
    t, no = _foam_list(pm / "owner")
    owner = np.array(t.split("\n")[:no], int)
    btxt = (pm / "boundary").read_text()
    bnd = {name: (int(s), int(c)) for name, c, s in
           re.findall(r"\n\s*(\w+)\s*\n\s*\{[^}]*?nFaces\s+(\d+);\s*startFace\s+(\d+);", btxt)}
    return pts, faces, owner, bnd


def face_geometry(pts: np.ndarray, faces, sel: range) -> tuple[np.ndarray, np.ndarray]:
    """Centres and area vectors for the selected faces (planar quads from the hex mesh)."""
    c = np.zeros((len(sel), 3))
    s = np.zeros((len(sel), 3))
    for k, f in enumerate(faces[i] for i in sel):
        p = pts[f]
        c[k] = p.mean(0)
        s[k] = 0.5 * np.cross(p[2] - p[0], p[3] - p[1]) if len(f) == 4 else 0.5 * np.cross(p[1] - p[0], p[2] - p[0])
    return c, s


def columns(p: Patch, C: np.ndarray):
    i = np.clip((C[:, 0] / p.cell_m).astype(int), 0, p.nx - 1)
    j = np.clip((C[:, 1] / p.cell_m).astype(int), 0, p.ny - 1)
    k = np.clip(((C[:, 2] - p.zmin) / p.dz).astype(int), 0, p.nz - 1)
    return i, j, k


def frame(p: Patch, C: np.ndarray, alpha: np.ndarray, U: np.ndarray):
    """depth [ny,nx] (water column above the local floor), surface and mid-depth (u, v) [ny,nx] each."""
    i, j, k = columns(p, C)
    depth = np.zeros((p.ny, p.nx))
    np.add.at(depth, (j, i), alpha * p.dz)
    wet_top = np.full((p.ny, p.nx), -1)
    sel = alpha >= 0.5
    np.maximum.at(wet_top, (j[sel], i[sel]), k[sel])
    floor = np.full((p.ny, p.nx), p.nz)
    np.minimum.at(floor, (j, i), k)
    mid_k = np.where(wet_top >= 0, (floor + wet_top) // 2, -1)
    us, um = np.zeros((p.ny, p.nx, 2)), np.zeros((p.ny, p.nx, 2))
    at_top = sel & (k == wet_top[j, i])
    at_mid = sel & (k == mid_k[j, i])
    us[j[at_top], i[at_top]] = U[at_top, :2]
    um[j[at_mid], i[at_mid]] = U[at_mid, :2]
    return depth, us, um


DEPTH_MAX_M = 4.0


def surface_png(depth: np.ndarray, vmax: float = DEPTH_MAX_M) -> bytes:
    """16-bit depth in R (high byte) and G (low byte): depth = (R*256 + G) / 65535 * vmax; A = 255 where wet.
    Rows flipped to north-up for the image."""
    q = np.round(np.clip(depth / vmax, 0, 1) * 65535).astype(np.uint32)[::-1]
    rgba = np.zeros(q.shape + (4,), np.uint8)
    rgba[..., 0], rgba[..., 1] = q >> 8, q & 255
    rgba[..., 3] = np.where(depth[::-1] >= 0.02, 255, 0)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG")
    return buf.getvalue()


def velocity_png(us: np.ndarray, um: np.ndarray, vmax: float) -> bytes:
    """R, G = surface u, v; B, A = mid-depth u, v; each (X - 128) * vmax / 127 m/s. North-up."""
    s = vmax / 127
    enc = lambda a: np.clip(np.round(a / s) + 128, 1, 255).astype(np.uint8)[::-1]  # noqa: E731
    rgba = np.stack([enc(us[..., 0]), enc(us[..., 1]), enc(um[..., 0]), enc(um[..., 1])], -1)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG")
    return buf.getvalue()


def building_forces(p: Patch, fc: np.ndarray, sf: np.ndarray, p_gauge: np.ndarray) -> np.ndarray:
    """Net horizontal force (N, [nb, 2]) on each building from wall-face pressures. A wall face's area vector
    points out of the fluid, into the solid cell behind it, which tells us which building it belongs to."""
    out = np.zeros((len(p.building_ids), 2))
    horiz = np.abs(sf[:, 2]) < 1e-9 * np.linalg.norm(sf, axis=1).clip(1e-12)
    n = sf / np.linalg.norm(sf, axis=1, keepdims=True).clip(1e-12)
    behind = fc + n * (p.cell_m / 2)
    i = np.clip((behind[:, 0] / p.cell_m).astype(int), 0, p.nx - 1)
    j = np.clip((behind[:, 1] / p.cell_m).astype(int), 0, p.ny - 1)
    b = p.building[j, i]
    keep = horiz & (b >= 0)
    np.add.at(out, b[keep], (p_gauge[keep, None] * sf[keep, :2]))
    return out
