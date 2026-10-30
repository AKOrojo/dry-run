"""Derived per-run maps from the stored depth frames (owner: Eng A; route in api/main.py).

Lives outside dryrun/sim on purpose: SOLVER_VERSION hashes the sim sources, so code here never changes
run_ids and the warmed runs stay valid. Nothing is added to RunManifest; the UI builds
`/api/runs/{run_id}/derived/{kind}.png` (and `.json` for the legend) from the run_id.

  arrival   minutes from storm start until a cell first reaches FLOODED_M (0.15 m)
  duration  minutes a cell spends at or above FLOODED_M

Both come from the frames, so they are accurate to the nearest frame (a wet frame counts the interval
before it). Cells that never reach the threshold, and permanent water (the run's exclude mask, as in the
depth frames), are transparent. Colour: the design system's `hazard` hue at stepped opacity (Eng B).
"""

from __future__ import annotations

import io
import json

import numpy as np
from PIL import Image

from dryrun import storage
from dryrun.sim import exposure

KINDS = ("arrival", "duration")
HAZARD_RGB = (0xFF, 0x6B, 0x2C)
LONG_RUN_MIN = 360  # runs longer than this (the Texas replay, 12 h) get wider bins


def edges_min(kind: str, run_min: float) -> list[int]:
    """Bin edges in minutes, fixed per run length so A/B runs share a legend. Set from the warmed presets:
    Lagos 120 mm / 3 h arrival quartiles 80/100/120 min, duration 190/260/290 of 360; Texas replay arrival
    180/230/270 (the river front reaches the valley 3-5 h in), duration 300/450/530 of 720."""
    long = run_min > LONG_RUN_MIN
    if kind == "arrival":
        return [180, 240, 300] if long else [60, 90, 120]
    return [300, 420, 540] if long else [60, 180, 300]


ALPHAS = {"arrival": [1.0, 0.72, 0.48, 0.28],   # earliest arrival is the strongest
          "duration": [0.28, 0.48, 0.72, 1.0]}  # longest duration is the strongest


def compute(run_id: str) -> dict[str, np.ndarray]:
    """{"arrival": minutes or NaN, "duration": minutes or NaN} on the AOI grid."""
    from dryrun.sim import engine

    m = storage.load_run(run_id)
    excl = engine._load_inputs(m.scenario)[1].exclude_mask
    arrival = None
    duration = None
    prev_t = m.frames[0].t_s
    for f in m.frames:
        wet = (storage.load_depth(run_id, f.depth) >= exposure.FLOODED_M) & ~excl
        if arrival is None:
            arrival = np.full(wet.shape, np.nan)
            duration = np.zeros(wet.shape)
        arrival[wet & np.isnan(arrival)] = f.t_s / 60
        duration[wet] += (f.t_s - prev_t) / 60
        prev_t = f.t_s
    duration[np.isnan(arrival)] = np.nan
    return {"arrival": arrival, "duration": duration}


def png(kind: str, minutes: np.ndarray, edges: list[int]) -> bytes:
    rgba = np.zeros(minutes.shape + (4,), np.uint8)
    seen = ~np.isnan(minutes)
    alpha = np.array(ALPHAS[kind])[np.digitize(np.where(seen, minutes, 0), edges, right=True)]
    rgba[..., :3] = HAZARD_RGB
    rgba[..., 3] = np.where(seen, np.round(alpha * 255), 0).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def legend(kind: str, edges: list[int], m) -> dict:
    return {"kind": kind, "units": "min", "edges_min": edges, "alphas": ALPHAS[kind],
            "rgb": "#{:02X}{:02X}{:02X}".format(*HAZARD_RGB), "threshold_m": exposure.FLOODED_M,
            "frame_interval_min": round((m.frames[1].t_s - m.frames[0].t_s) / 60, 2) if len(m.frames) > 1 else None,
            "run_min": round(m.frames[-1].t_s / 60, 1),
            "note": f"to the nearest frame; threshold {exposure.FLOODED_M} m is an assumption"}


def rel(kind: str, ext: str) -> str:
    return f"derived/{kind}.{ext}"


def derive(run_id: str) -> None:
    """Write derived/<kind>.png and .json for every kind (idempotent: outputs are immutable per run)."""
    m = storage.load_run(run_id)
    run_min = m.frames[-1].t_s / 60
    for kind, minutes in compute(run_id).items():
        edges = edges_min(kind, run_min)
        storage.write_run_file(run_id, rel(kind, "png"), png(kind, minutes, edges), "image/png")
        storage.write_run_file(run_id, rel(kind, "json"), json.dumps(legend(kind, edges, m)).encode(),
                               "application/json")


def exists(run_id: str, kind: str) -> bool:
    return storage._exists("runs", f"{run_id}/{rel(kind, 'json')}")
