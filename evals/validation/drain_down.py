"""Drain-down check against Sentinel-1 (owner: Eng A).

Use this when the satellite pass comes days after the storm and sees (almost) no flood water. CSI is
meaningless against an empty observation, but the observation still constrains the model: by the pass
time, the simulated flooded area on land should have drained to about what S1 sees. A model that still
holds lots of water then retains it too long (closed pits, no evaporation, infiltration too low).

Runs the solver directly, past the API's 12 h sim_hours cap, which is fine offline. Rain is the scenario
storm; nothing falls after it.

  python evals/validation/drain_down.py --aoi lagos-lekki-v1 --mm 57 --storm-h 6 --report-h 6 48 \\
      --obs data/raw/lagos-lekki/s1/20260712

With --series (an IMERG file from imerg.py) the observed rain replaces the synthetic storm, and --report-at
takes UTC times, e.g. the S1 pass:

  python evals/validation/drain_down.py --aoi lagos-lekki-v1 --series evals/validation/imerg_lagos_20260709-12.json \\
      --report-at 2026-07-10T16:00 2026-07-12T05:29 --obs data/raw/lagos-lekki/s1/20260712
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import time
from pathlib import Path

import numpy as np


def _series_rain(path: str):
    """Cumulative-rain function (seconds since the first step -> mm) and the start time of an IMERG series."""
    rows = json.load(open(path))["rows"]
    t0 = dt.datetime.fromisoformat(rows[0][0])
    edges = [(dt.datetime.fromisoformat(t) - t0).total_seconds() for t, _ in rows]
    edges.append(edges[-1] + 1800)
    cum = np.concatenate([[0.0], np.cumsum([r * 0.5 for _, r in rows])])
    return (lambda t: float(np.interp(t, edges, cum))), t0


def run(aoi_id: str, mm: float, storm_h: float, report_h: list[float], obs_dir: str | None = None,
        series: str | None = None, report_at: list[str] | None = None) -> dict:
    from dryrun.contracts import ScenarioSpec, Storm
    from dryrun.sim import engine, exposure, solver
    from dryrun.sim.interventions import rain_cum_mm

    spec = ScenarioSpec(aoi_id=aoi_id, storm=Storm(total_mm=mm or 1, duration_h=storm_h))  # only loads inputs with --series
    aoi, inp = engine._load_inputs(spec)
    land = ~inp.exclude_mask
    cell_km2 = aoi.grid.dx_m * aoi.grid.dy_m / 1e6
    ids, bc = exposure.building_cells(aoi_id)
    bmask = np.zeros(land.shape, np.float32)
    bmask[bc[:, 0], bc[:, 1]] = 1
    # C-band SAR cannot see water among buildings (double bounce brightens it): "open" = no building in 3x3
    open_ = land & (exposure.neighbourhood_max(bmask) == 0)
    obs = valid = None
    if obs_dir:
        obs = np.load(Path(obs_dir) / "obs_flood_extent.npy") > 0.5
        valid = np.load(Path(obs_dir) / "valid.npy") > 0.5

    if series:
        cum_mm, start = _series_rain(series)
        report_h = [(dt.datetime.fromisoformat(t) - start).total_seconds() / 3600 for t in report_at or []] or report_h
    else:
        start = None
        cum_mm = lambda t: rain_cum_mm(spec, t)  # noqa: E731
    t0 = time.time()
    times = sorted({h * 3600.0 for h in report_h})
    frames, _ = solver.integrate(inp, times, lambda a, b: (cum_mm(b) - cum_mm(a)) / 1000)
    rows, peak = [], np.zeros_like(frames[0][1])
    for t, d in frames[1:]:
        peak = np.maximum(peak, d)
        wet = (d >= exposure.FLOODED_M) & land
        row = {"t_h": round(t / 3600, 2), "rain_so_far_mm": round(cum_mm(t), 1),
               "wet_land_km2": round(float(wet.sum() * cell_km2), 3),
               "wet_land_ge_0_3m_km2": round(float(((d >= 0.3) & land).sum() * cell_km2), 3),
               "wet_open_km2": round(float((wet & open_).sum() * cell_km2), 3),
               "buildings_flooded_3x3": int((exposure.neighbourhood_max(np.where(land, d, 0))[bc[:, 0], bc[:, 1]]
                                             >= exposure.FLOODED_M).sum()),
               "stored_land_m3": round(float(np.where(land, d, 0).astype(np.float64).sum()) * cell_km2 * 1e6)}
        if obs is not None:
            v = valid & land
            row["obs_wet_km2"] = round(float((obs & v).sum() * cell_km2), 3)
            row["sim_wet_where_obs_valid_km2"] = round(float((wet & v).sum() * cell_km2), 3)
            row["sim_wet_also_obs_km2"] = round(float((wet & obs & v).sum() * cell_km2), 3)
        if start:
            row["utc"] = (start + dt.timedelta(seconds=t)).isoformat(timespec="minutes")
        rows.append(row)
    storm = {"series": series} if series else {"storm_mm": mm, "storm_h": storm_h}
    return {"aoi_id": aoi_id, **storm, "solver_s": round(time.time() - t0, 1),
            "threshold_m": exposure.FLOODED_M, "rows": rows}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", required=True)
    ap.add_argument("--mm", type=float, help="synthetic storm total (ignored with --series)")
    ap.add_argument("--storm-h", type=float, default=6)
    ap.add_argument("--report-h", type=float, nargs="+", default=[6, 12, 24, 36, 48])
    ap.add_argument("--series", help="IMERG rain series JSON from imerg.py; replaces the synthetic storm")
    ap.add_argument("--report-at", nargs="+", help="UTC report times with --series, e.g. 2026-07-12T05:29")
    ap.add_argument("--obs", help="folder with obs_flood_extent.npy + valid.npy on the AOI grid")
    a = ap.parse_args()
    if a.mm is None and not a.series:
        ap.error("give --mm or --series")
    print(json.dumps(run(a.aoi, a.mm or 0, a.storm_h, a.report_h, a.obs, a.series, a.report_at), indent=1))


if __name__ == "__main__":
    main()
