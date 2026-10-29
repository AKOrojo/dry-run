"""Sentinel-1 validation: Critical Success Index of simulated vs observed max flood extent (owner: Eng A).

    CSI = hits / (hits + misses + false_alarms)      (also POD, FAR, frequency bias)
Simulated wet = run max depth >= exposure.FLOODED_M; observed wet = the AOI's optional
`obs_flood_extent` layer (Sentinel-1 change detection exported by Eng D). Permanent water
(exclude_mask) and boundary cells are left out of both: they are wet in every scene and would
inflate the score. Report the number even if it is mediocre; the model card says how it was made.

  DRYRUN_STORAGE=gcs python evals/validation/csi.py <run_id> [--obs-layer obs_flood_extent]
If the AOI has no observed layer (Earth Engine not registered), it says so and exits 2: skip, and
say so in the model card. Never substitute a different scene silently.
"""

from __future__ import annotations

import argparse
import json
import sys

import numpy as np


def scores(sim_wet: np.ndarray, obs_wet: np.ndarray, valid: np.ndarray | None = None) -> dict:
    v = np.ones(sim_wet.shape, bool) if valid is None else np.asarray(valid, bool)
    s, o = np.asarray(sim_wet, bool) & v, np.asarray(obs_wet, bool) & v
    hits, misses, fa = int((s & o).sum()), int((~s & o & v).sum()), int((s & ~o & v).sum())
    denom = hits + misses + fa
    return {"csi": round(hits / denom, 4) if denom else None,
            "pod": round(hits / (hits + misses), 4) if hits + misses else None,
            "far": round(fa / (hits + fa), 4) if hits + fa else None,
            "bias": round((hits + fa) / (hits + misses), 4) if hits + misses else None,
            "hits": hits, "misses": misses, "false_alarms": fa, "cells_compared": int(v.sum())}


def run_csi(run_id: str, obs_layer: str = "obs_flood_extent", threshold_m: float | None = None) -> dict:
    from dryrun import storage
    from dryrun.sim import exposure

    m = storage.load_run(run_id)
    aoi = storage.load_aoi(m.scenario.aoi_id)
    if obs_layer not in aoi.layers:
        raise LookupError(f"AOI {aoi.aoi_id} has no {obs_layer!r} layer (Sentinel-1 scene not exported)")
    thr = exposure.FLOODED_M if threshold_m is None else threshold_m
    depth = storage.load_depth(run_id, "max_depth.npy")
    obs = storage.load_raster(aoi.aoi_id, obs_layer) > 0.5
    valid = ~(storage.load_raster(aoi.aoi_id, "exclude_mask") > 0.5) & ~(
        storage.load_raster(aoi.aoi_id, "boundary_mask") > 0.5)
    return {"run_id": run_id, "aoi_id": aoi.aoi_id, "obs_layer": obs_layer, "obs_source": aoi.sources.get(obs_layer),
            "threshold_m": thr, "backend": m.backend, **scores(depth >= thr, obs, valid)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_id")
    ap.add_argument("--obs-layer", default="obs_flood_extent")
    ap.add_argument("--threshold-m", type=float)
    a = ap.parse_args()
    try:
        print(json.dumps(run_csi(a.run_id, a.obs_layer, a.threshold_m), indent=2))
    except LookupError as exc:
        print(f"SKIPPED: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
