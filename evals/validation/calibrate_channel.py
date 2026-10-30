"""One-parameter calibration of the Texas channel depth (owner: Eng A).

At 2" (~60 m) the Guadalupe channel averages into its banks: the carved bed sits ~8 m above Cesium World
Terrain's river cells (terrain_match.py) and peak depths run high. This lowers every river/outlet cell by
DEEPEN metres (the carved slope is unchanged), optionally scales the channel Manning n, and replays the
4 Jul 2025 demo scenario.

Calibration target: the water-surface rise at the Kerrville gauge (USGS 08166200): 11.4 m observed from the
pre-event low to the 37.51 ft crest. Hunt failed at the crest (>= 9.1 m), so it is a lower bound and not fitted.
Held out: the USGS high-water marks and FIMbench extent (texas_hwm.py), and the Hunt bound.

  python evals/validation/calibrate_channel.py --deepen 0 2 4 6 8
"""

from __future__ import annotations

import argparse
import csv
import dataclasses
import json
import os

import numpy as np

HERE = os.path.dirname(__file__)
GAUGES = {"08166200": ("Kerrville", 11.4), "08165500": ("Hunt", 9.1)}  # observed rise, m (Hunt: lower bound)
WINDOW = 2


def channel_mask(inp) -> np.ndarray:
    """River cells (permanent water) and the outlet: the cells carve_rivers() lowered."""
    return np.asarray(inp.exclude_mask, bool) | np.asarray(inp.boundary_mask, bool)


def run(deepen: list[float], fimbench: str | None, fimbench_aoi: str | None,
        n_scales: list[float] = (1.0,)) -> list[dict]:
    from dryrun import presets
    from dryrun.contracts import ScenarioSpec
    from dryrun.sim import engine, solver
    from evals.validation import texas_hwm

    spec = ScenarioSpec.model_validate(next(s for s in presets.demo()["scenarios"]
                                            if s["aoi_id"].startswith("texas") and s["storm"]["total_mm"] > 0))
    aoi, inp = engine._load_inputs(spec)
    gauges = json.load(open(os.path.join(HERE, "usgs_guadalupe_20250704.json")))["sites"]
    w, s, e, n = aoi.grid.bounds_wgs84
    ny, nx = inp.dem.shape
    rows = list(csv.DictReader(open(os.path.join(HERE, "usgs_hwm_event357_aoi.csv"))))
    chan = channel_mask(inp)
    out = []
    for dd, ns in [(d, k) for d in deepen for k in n_scales]:
        dem = np.where(chan, inp.dem - dd, inp.dem).astype(np.float32)
        ip = dataclasses.replace(inp, dem=dem, manning=np.where(chan, inp.manning * ns, inp.manning))
        frames, _ = solver.simulate(ip, spec, aoi.grid.dx_m)
        depth = np.array([f for _, f in frames])
        wse = dem[None] + np.where(depth > 0.05, depth, np.nan)
        row = {"deepen_m": dd, "channel_n_scale": ns, "gauges": {}}
        for site, (name, obs) in GAUGES.items():
            g = gauges[site]
            r = int((n - g["lat"]) / (n - s) * ny)
            c = int((g["lon"] - w) / (e - w) * nx)
            win = wse[:, max(r - WINDOW, 0):r + WINDOW + 1, max(c - WINDOW, 0):c + WINDOW + 1]
            series = np.nanmax(win.reshape(len(frames), -1), axis=1)
            # the channel starts dry (no base flow before the gauge inflows begin), so the pre-event level is the
            # lowest wet level the cells reach, i.e. the first trickle; the observed rise is also from the pre-event low
            base = np.nanmin(series)
            row["gauges"][name] = {"model_rise_m": round(float(np.nanmax(series) - base), 2), "observed_m": obs}
        maxd = depth.max(axis=0)
        row["hwm"] = texas_hwm.score_hwms(aoi, dem.astype(np.float64), maxd, rows)["groups"]["primary (Excellent/Good/Fair)"]
        if fimbench:
            row["extent_0.15"] = texas_hwm.score_extent(aoi, maxd, fimbench, fimbench_aoi)["by_threshold"]["0.15"]
        out.append(row)
        print(json.dumps(row), flush=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--deepen", type=float, nargs="+", default=[0, 2, 4, 6, 8])
    ap.add_argument("--n-scale", type=float, nargs="+", default=[1.0])
    ap.add_argument("--fimbench")
    ap.add_argument("--fimbench-aoi")
    a = ap.parse_args()
    run(a.deepen, a.fimbench, a.fimbench_aoi, a.n_scale)


if __name__ == "__main__":
    main()
