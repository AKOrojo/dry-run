"""One-parameter calibration of the built-up loss rate on the Sentinel-1 drain-down (owner: Eng A).

The drain-down remainder sits in closed DEM depressions (pits.py) that empty only by infiltration, and built-up
cells (WorldCover 50, about half the land) lose 2 mm/h. Lekki stands on coastal sand, compounds drain to
soakaways, and many drains are unmapped, so the effective built-up loss is uncertain. This sweeps that one rate.
For each value it reports the S1 drain-down targets (radar-visible open water at the pass) and the peak impact of
the 120 mm / 3 h preset, so the choice is visibly a trade-off and not a free fit. This is calibration, not
validation.

  python evals/validation/calibrate_builtup.py --rates 2 4 6 8 10 12 15
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json

import numpy as np

PASSES = [("evals/validation/imerg_lagos_20260709-12.json", "2026-07-12T05:29"),
          ("evals/validation/imerg_lagos_20260626-30.json", "2026-06-30T05:29")]
BUILT_UP_MM_H = 2.0  # the current LUT value; unique to WorldCover 50 in the LUT


def run(aoi_id: str, rates: list[float]) -> list[dict]:
    from dryrun.contracts import ScenarioSpec, Storm
    from dryrun.sim import engine, exposure, solver
    from dryrun.sim.interventions import rain_cum_mm
    from evals.validation.drain_down import _series_rain

    spec = ScenarioSpec(aoi_id=aoi_id, storm=Storm(total_mm=120, duration_h=3, pattern="center_peaked"))
    aoi, inp = engine._load_inputs(spec)
    land = ~inp.exclude_mask
    built = np.asarray(inp.infiltration_mm_h) == BUILT_UP_MM_H
    km2 = aoi.grid.dx_m * aoi.grid.dy_m / 1e6
    _, bc = exposure.building_cells(aoi_id)
    bmask = np.zeros(land.shape, np.float32)
    bmask[bc[:, 0], bc[:, 1]] = 1
    open_ = land & (exposure.neighbourhood_max(bmask) == 0)
    out = []
    for rate in rates:
        infil = np.where(built, rate, inp.infiltration_mm_h)
        ip = dataclasses.replace(inp, infiltration_mm_h=infil)
        row = {"built_up_mm_h": rate}
        for series, at in PASSES:
            cum, start = _series_rain(series)
            t = (dt.datetime.fromisoformat(at) - start).total_seconds()
            (_, d), = solver.integrate(ip, [t], lambda a, b: (cum(b) - cum(a)) / 1000)[0][1:]
            wet = (d >= exposure.FLOODED_M) & land
            row[at] = {"wet_land_km2": round(float(wet.sum() * km2), 3), "wet_open_km2": round(float((wet & open_).sum() * km2), 3)}
        times = [i * 600.0 for i in range(1, 37)]
        frames, _ = solver.integrate(ip, times, lambda a, b: (rain_cum_mm(spec, b) - rain_cum_mm(spec, a)) / 1000)
        peak = np.max([f for _, f in frames], axis=0)
        bd = exposure.neighbourhood_max(np.where(land, peak, 0))[bc[:, 0], bc[:, 1]]
        row["preset_120mm_3h"] = {"flooded_km2": round(float(((peak >= exposure.FLOODED_M) & land).sum() * km2), 2),
                                  "buildings_flooded": int((bd >= exposure.FLOODED_M).sum()),
                                  "max_depth_m": round(float(peak[land].max()), 2)}
        out.append(row)
        print(json.dumps(row), flush=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", default="lagos-lekki-v1")
    ap.add_argument("--rates", type=float, nargs="+", default=[2, 4, 6, 8, 10, 12, 15])
    a = ap.parse_args()
    run(a.aoi, a.rates)


if __name__ == "__main__":
    main()
