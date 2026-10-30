"""Run one 3D patch end to end (owner: Eng A).

  python -m dryrun.patch3d.run --run r_... --center 3.535 6.44 [--size 200 --cell 2 --t0 .. --t1 ..]

OpenFOAM runs from the PATH (the batch image) or, for local development, in a container:
DRYRUN_OPENFOAM_IMAGE=docker.io/opencfd/openfoam-default:2406 (podman). Results go to the runs bucket under
runs/<run_id>/patch3d/<patch_id>/ and the manifest is written last.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np

from dryrun import storage
from dryrun.contracts import Patch3DFrame, Patch3DManifest, Patch3DRequest, RunStatus
from dryrun.patch3d import case as C
from dryrun.patch3d import geometry, post

OF_BASHRC = "/usr/lib/openfoam/openfoam2406/etc/bashrc"
DEFAULT_WINDOW_S = 600.0
MPI_ENV = "export OMPI_ALLOW_RUN_AS_ROOT=1 OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1 OMPI_MCA_btl_vader_single_copy_mechanism=none;"


def of(case: Path, cmd: str, log: str) -> None:
    script = f"source {OF_BASHRC} >/dev/null 2>&1; {MPI_ENV} cd /case && {cmd} > {log} 2>&1"
    image = os.getenv("DRYRUN_OPENFOAM_IMAGE")
    if image:
        argv = ["podman", "run", "--rm", "--userns=keep-id", "-v", f"{case}:/case:Z", image, "bash", "-c", script]
    else:
        argv = ["bash", "-c", script.replace("/case", str(case))]
    r = subprocess.run(argv, capture_output=True, text=True)
    if r.returncode != 0:
        tail = (case / log).read_text()[-1500:] if (case / log).exists() else r.stderr[-1500:]
        raise RuntimeError(f"{cmd.split()[0]} failed: {tail}")


def rel(pid: str, run_id: str, name: str) -> str:
    return f"patch3d/{pid}/{name}"


def save(run_id: str, pid: str, name: str, data: bytes, ctype: str) -> str:
    storage.write_run_file(run_id, rel(pid, run_id, name), data, ctype)
    return rel(pid, run_id, name)


def write_manifest(m: Patch3DManifest) -> None:
    save(m.request.run_id, m.patch_id, "manifest.json", m.model_dump_json().encode(), "application/json")


def index(run_id: str) -> list[dict]:
    try:
        return json.loads(storage.read_run_file(run_id, "patch3d/index.json"))
    except Exception:  # noqa: BLE001 - no patches yet
        return []


def update_index(m: Patch3DManifest) -> None:
    rows = [r for r in index(m.request.run_id) if r["patch_id"] != m.patch_id]
    rows.append({"patch_id": m.patch_id, "status": m.status.value, "center": list(m.request.center),
                 "size_m": m.request.size_m, "cell_m": m.request.cell_m, "bounds_wgs84": m.bounds_wgs84,
                 "t_window_s": m.t_window_s})
    storage.write_run_file(m.request.run_id, "patch3d/index.json", json.dumps(rows).encode(), "application/json")


def load_manifest(run_id: str, pid: str) -> Patch3DManifest:
    return Patch3DManifest.model_validate_json(storage.read_run_file(run_id, rel(pid, run_id, "manifest.json")))


def run(req: Patch3DRequest, workdir: Path | None = None, keep: bool = False,
        post_only: bool = False) -> Patch3DManifest:
    """post_only: the case in workdir is already solved; redo only the frames, forces and manifest."""
    t_start = time.time()
    pid = req.patch_id()
    man = Patch3DManifest(patch_id=pid, request=req, status=RunStatus.running)
    write_manifest(man)
    tmp = Path(workdir or tempfile.mkdtemp(prefix=f"{pid}_"))
    try:
        forcing = C.Forcing(req.run_id)
        lon, lat = req.center
        if req.t_window_s:
            t0, t1 = req.t_window_s
        else:
            t1 = forcing.peak_time(lon, lat)
            t0 = max(0.0, t1 - DEFAULT_WINDOW_S)
            if t1 - t0 < 120:
                t1 = t0 + DEFAULT_WINDOW_S
        # highest 2D water surface the patch will see (sets the domain top)
        probe = geometry.build(forcing.aoi.aoi_id, req.center, req.size_m, req.size_m / 8, 0.0)
        g = (np.arange(9) + 0.5) * req.size_m / 9
        X, Y = np.meshgrid(g, g)
        plon, plat = probe.lonlat(X.ravel(), Y.ravel())
        max_wse = max(float(forcing.sample(plon, plat, t)[0].max()) for t in np.linspace(t0, t1, 7))
        p = geometry.build(forcing.aoi.aoi_id, req.center, req.size_m, req.cell_m, max_wse)
        n_fluid = int((~p.solid()).sum())
        procs = C.procs_for(n_fluid)
        if post_only:
            cc = C.read_cell_centres(tmp, n_fluid)
            checks = {"sides": C.side_roles(p, forcing, t0, t1)}
            procs = 0
        else:
            info = C.write_case(tmp, p, forcing, t0, t1, procs)
            of(tmp, "blockMesh", "log.blockMesh")
            C.write_cellset(tmp, p)
            of(tmp, "subsetMesh fluid -patch walls -overwrite", "log.subsetMesh")
            (tmp / "0").mkdir(exist_ok=True)
            of(tmp, "postProcess -func writeCellCentres -time 0", "log.cellCentres")
            cc = C.read_cell_centres(tmp, n_fluid)
            checks = C.write_initial_fields(tmp, p, forcing, t0, cc, info["roles"])
        t_solve = time.time()
        if post_only:
            pass
        elif procs > 1:
            of(tmp, "decomposePar -force", "log.decomposePar")
            of(tmp, f"mpirun -np {procs} interFoam -parallel", "log.interFoam")
            of(tmp, "reconstructPar", "log.reconstructPar")
        else:
            of(tmp, "interFoam", "log.interFoam")
        solve_s = time.time() - t_solve
        man = post_process(tmp, p, forcing, req, pid, t0, t1, cc, man)
        man = man.model_copy(update={
            "checks": {**man.checks, **checks, "cells": n_fluid, "procs": procs, "solve_s": round(solve_s, 1),
                       "blocks": [p.nx, p.ny, p.nz], "dz_m": p.dz},
            "cells": n_fluid, "status": RunStatus.done})
    except Exception as exc:  # noqa: BLE001 - the manifest must say why
        man = man.model_copy(update={"status": RunStatus.failed, "error": str(exc)[-2000:]})
    man = man.model_copy(update={"elapsed_s": round(time.time() - t_start, 1)})
    write_manifest(man)
    update_index(man)
    if not keep and workdir is None:
        shutil.rmtree(tmp, ignore_errors=True)
    return man


def post_process(case: Path, p, forcing, req, pid, t0, t1, cc, man) -> Patch3DManifest:
    times = sorted((float(d.name), d) for d in case.iterdir() if d.is_dir() and _num(d.name))
    pts, faces, owner, bnd = post.read_mesh(case)
    s, n = bnd["walls"]
    fc, sf = post.face_geometry(pts, faces, range(s, s + n))
    ztop = p.zmin + p.nz * p.dz
    cell_area = p.cell_m * p.cell_m
    X, Y = np.meshgrid((np.arange(p.nx) + 0.5) * p.cell_m, (np.arange(p.ny) + 0.5) * p.cell_m)
    lon, lat = p.lonlat(X.ravel(), Y.ravel())
    open_cols = (p.building < 0).ravel()
    frames, depths, surf, mid, forces, vol3, vol2 = [], [], [], [], [], [], []
    buildings = None
    for t, d in times:
        alpha = post.read_internal(d / "alpha.water", len(cc))
        U = post.read_internal(d / "U", len(cc))
        depth, us, um = post.frame(p, cc, alpha, U)
        depths.append(depth)
        surf.append(us)
        mid.append(um)
        pv = post.read_patch_values(d / "p", "walls") if (d / "p").exists() else None
        if pv is not None:
            forces.append(post.building_forces(p, fc, sf, pv + C.RHO_AIR * 9.81 * ztop))
        vol3.append(float(depth.ravel()[open_cols].sum() * cell_area))
        wse2, _, _ = forcing.sample(lon, lat, t0 + t)
        d2 = np.clip(wse2 - p.ground.ravel(), 0, None)
        vol2.append(float(d2[open_cols].sum() * cell_area))
    vmax = max(0.5, float(np.ceil(max(np.abs(np.concatenate([np.ravel(a) for a in surf + mid])).max(), 0.01) * 2) / 2))
    for (t, _), depth, us, um in zip(times, depths, surf, mid):
        k = len(frames)
        frames.append(Patch3DFrame(
            t_s=round(t0 + t, 1),
            surface=save(req.run_id, pid, f"frames/{k:04d}_surface.png", post.surface_png(depth), "image/png"),
            velocity=save(req.run_id, pid, f"frames/{k:04d}_velocity.png", post.velocity_png(us, um, vmax), "image/png")))
    if forces and p.building_ids:
        F = np.array(forces)  # [frames, nb, 2] N
        mag = np.hypot(F[..., 0], F[..., 1])
        kmax = mag.argmax(0)
        nb = np.arange(len(p.building_ids))
        bl = {"ids": p.building_ids, "peak_force_kN": np.round(mag[kmax, nb] / 1000, 2).tolist(),
              "t_s": [round(t0 + times[k][0], 1) for k in kmax],
              "direction_deg": np.round(np.degrees(np.arctan2(F[kmax, nb, 0], F[kmax, nb, 1])) % 360, 0).tolist(),
              "method": "net horizontal pressure force on each footprint's wall faces from the 3D solve (pressure "
                        "relative to the open top); no shear; stair-stepped walls at cell_m"}
        buildings = save(req.run_id, pid, "buildings.json", json.dumps(bl).encode(), "application/json")
    w, s_, e, n_ = p.bounds_wgs84
    encoding = {"surface": f"depth_m = (R*256 + G) / 65535 * {post.DEPTH_MAX_M}; A = 255 where depth >= 0.02 m; "
                               "depth is the water column above the local floor (ground, or a roof); north-up",
                    "velocity": f"surface u = (R-128)*s, v = (G-128)*s; mid-depth u = (B-128)*s, v = (A-128)*s; "
                                f"s = {vmax / 127:.6f} m/s; u east, v north; north-up",
                    "vmax_m_s": vmax, "depth_max_m": post.DEPTH_MAX_M,
                    "ground": "patch ground = the AOI DEM, bilinear; building tops = highest ground under the "
                              "footprint + height_m"}
    checks = {**man.checks, "water_volume_3d_m3": [round(v, 1) for v in vol3],
              "water_volume_2d_m3": [round(v, 1) for v in vol2],
              "volume_diff_end_pct": round(100 * (vol3[-1] - vol2[-1]) / vol2[-1], 1) if vol2 and vol2[-1] > 0 else None}
    return man.model_copy(update={"buildings": buildings, "bounds_wgs84": (w, s_, e, n_), "nx": p.nx, "ny": p.ny,
                                  "t_window_s": (t0, t1), "frames": frames, "encoding": encoding, "checks": checks})


def _num(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--center", type=float, nargs=2, required=True)
    ap.add_argument("--size", type=float, default=200)
    ap.add_argument("--cell", type=float, default=2.0)
    ap.add_argument("--t0", type=float)
    ap.add_argument("--t1", type=float)
    ap.add_argument("--workdir")
    ap.add_argument("--post-only", action="store_true", help="the case in --workdir is solved; redo the outputs")
    a = ap.parse_args()
    req = Patch3DRequest(run_id=a.run, center=tuple(a.center), size_m=a.size, cell_m=a.cell,
                         t_window_s=(a.t0, a.t1) if a.t0 is not None else None)
    m = run(req, Path(a.workdir) if a.workdir else None, keep=bool(a.workdir), post_only=a.post_only)
    print(json.dumps({k: v for k, v in json.loads(m.model_dump_json()).items() if k != "frames"}, indent=1))


if __name__ == "__main__":
    main()
