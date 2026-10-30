"""Inputs for the in-browser 3D patch solver (owner: Eng A).

The browser solver (web/src/lib/patch3d-gpu, WebGPU) solves the same box as the OpenFOAM run: the same geometry
(geometry.build), time window and 2D forcing (run.prepare), the same side levels every BC_DT_S, the same sponge
band and bed roughness. It cannot read the AOI rasters (the data bucket is private), so this module packs what the
case writer would use into one JSON document, served at GET /api/runs/{run_id}/patch3d_inputs and cached in the
runs bucket next to the patch.

Arrays are base64 little-endian float32 (int32 for `building`), row-major [ny, nx] with row 0 = SOUTH (the case
frame: x east, y north from the SW corner). Water levels are nan where the 2D run is dry.
"""

from __future__ import annotations

import base64
import json

import numpy as np

from dryrun.contracts import Patch3DRequest
from dryrun.patch3d import case as C
from dryrun.patch3d import post

INPUTS_VERSION = 1
# The browser solver runs on the viewer's GPU, so it may take larger and finer boxes than the batch OpenFOAM job
# (Patch3DRequest: 60-300 m, cell >= 1 m); the GPU memory the viewer allows decides what fits (memory.ts).
SIZE_RANGE_M = (60.0, 500.0)
CELL_RANGE_M = (0.5, 4.0)


def request(run_id: str, center: tuple[float, float], size_m: float, cell_m: float,
            t_window_s: tuple[float, float] | None = None) -> Patch3DRequest:
    """A Patch3DRequest within the browser solver's ranges (wider than the batch job's). Raises ValueError."""
    if not (SIZE_RANGE_M[0] <= size_m <= SIZE_RANGE_M[1]):
        raise ValueError(f"size_m must be {SIZE_RANGE_M[0]:g}-{SIZE_RANGE_M[1]:g}")
    if not (CELL_RANGE_M[0] <= cell_m <= CELL_RANGE_M[1]):
        raise ValueError(f"cell_m must be {CELL_RANGE_M[0]:g}-{CELL_RANGE_M[1]:g}")
    if size_m / cell_m > 1000:
        raise ValueError("at most 1000 cells per side")
    if t_window_s is not None and not (0 <= t_window_s[0] < t_window_s[1] and t_window_s[1] - t_window_s[0] <= 3600):
        raise ValueError("t_window_s must be [t0, t1] with 0 <= t0 < t1 <= t0 + 3600")
    base = Patch3DRequest(run_id=run_id, center=center)  # validates run_id and center
    return Patch3DRequest.model_construct(**{**base.__dict__, "size_m": float(size_m), "cell_m": float(cell_m),
                                             "t_window_s": t_window_s})


def _f32(a) -> str:
    return base64.b64encode(np.ascontiguousarray(a, "<f4").tobytes()).decode()


def _i32(a) -> str:
    return base64.b64encode(np.ascontiguousarray(a, "<i4").tobytes()).decode()


def side_columns(p, side: str) -> tuple[np.ndarray, np.ndarray]:
    """Case (x, y) of the boundary face centres along one side, one per column (i along south/north, j along
    west/east)."""
    c = (np.arange(p.nx) + 0.5) * p.cell_m
    if side in ("south", "north"):
        return c, np.full(p.nx, 0.0 if side == "south" else p.size_m)
    return np.full(p.ny, 0.0 if side == "west" else p.size_m), c


def build(req: Patch3DRequest) -> dict:
    from dryrun.patch3d.run import SPINUP_S, prepare

    forcing, p, t0, t1 = prepare(req)
    X, Y = np.meshgrid((np.arange(p.nx) + 0.5) * p.cell_m, (np.arange(p.ny) + 0.5) * p.cell_m)
    lon, lat = p.lonlat(X.ravel(), Y.ravel())
    wse0, u0, v0 = forcing.sample(lon, lat, t0)
    bc_t = C._bc_times(t0, t1)
    sides = {}
    for side in C.SIDES:
        sx, sy = side_columns(p, side)
        slon, slat = p.lonlat(sx, sy)
        sides[side] = _f32(np.stack([forcing.sample(slon, slat, t0 + t)[0] for t in bc_t]))
    # the 2D run's water volume over the open (building-free) columns at each frame time: the same check the
    # OpenFOAM manifest carries (water_volume_2d_m3)
    open_cols = (p.building < 0).ravel()
    frame_t = list(np.arange(0.0, t1 - t0 + 1e-6, C.WRITE_DT_S))
    vol2 = []
    for t in frame_t:
        d2 = np.nan_to_num(np.clip(forcing.sample(lon, lat, t0 + t)[0] - p.ground.ravel(), 0, None))
        vol2.append(round(float(d2[open_cols].sum() * p.cell_m * p.cell_m), 1))
    return {
        "version": INPUTS_VERSION, "patch_id": req.patch_id(), "request": json.loads(req.model_dump_json()),
        "bounds_wgs84": list(p.bounds_wgs84), "nx": p.nx, "ny": p.ny, "nz": p.nz, "cell_m": p.cell_m,
        "dz": p.dz, "zmin": p.zmin, "t_window_s": [t0, t1], "bc_dt_s": C.BC_DT_S, "frame_dt_s": C.WRITE_DT_S,
        "spinup_s": SPINUP_S, "ground": _f32(p.ground), "top": _f32(p.top), "building": _i32(p.building),
        "building_ids": p.building_ids,
        "init": {"wse": _f32(wse0), "u": _f32(u0), "v": _f32(v0)},
        "sides": {"t_s": bc_t, **sides}, "vol2_m3": vol2,
        "physics": {"g": C.G, "rho_water": C.RHO_WATER, "ks_m": C.KS_GROUND_M, "u_cap_m_s": C.U_CAP_M_S,
                    "sponge_cells": C.SPONGE_CELLS, "sponge_tau_s": C.SPONGE_TAU_S, "dry_m": C.DRY_M},
        "encoding": {"depth_max_m": post.DEPTH_MAX_M},
    }


def dims(req: Patch3DRequest) -> dict:
    """The grid only, so the browser can check its GPU memory before downloading the inputs."""
    from dryrun.patch3d.run import prepare

    _, p, t0, t1 = prepare(req)
    return {"patch_id": req.patch_id(), "nx": p.nx, "ny": p.ny, "nz": p.nz, "cell_m": p.cell_m, "dz": p.dz,
            "span_m": round(p.nz * p.dz, 3), "cells": p.nx * p.ny * p.nz, "t_window_s": [t0, t1]}


def rel(req: Patch3DRequest) -> str:
    return f"patch3d/{req.patch_id()}/gpu_inputs.json"
