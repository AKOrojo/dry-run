"""River gauge timing check for an inland AOI with an `inflows` layer (owner: Eng A).

Replays an event on the solver: the AOI's gauge inflows plus observed IMERG rain from the inflows' t0,
with frames every few minutes. Then it compares the modelled peak at each gauge (max depth within
GAUGE_WINDOW cells of its lon/lat, since a gauge point rarely sits on the burned channel cell) with the
observed discharge from usgs.py. The test is the FRONT: the first time the modelled depth reaches half its
maximum vs the first time the observed discharge reaches half its peak, and the front's travel time
between gauges. Modelled crests are broad and flat (overbank storage), so the argmax peak time is
reported as context only, as is depth vs stage (we have no gauge datum).

  python evals/validation/gauge_timing.py --aoi texas-guadalupe-v0 \\
      --gauges evals/validation/usgs_guadalupe_20250704.json --rain evals/validation/imerg_guadalupe_20250704.json \\
      --sites 08165500 08166200 --hours 12 --every-min 5
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import time

import numpy as np

GAUGE_WINDOW = 2  # cells either side of the gauge point


def _epoch(t: str) -> float:
    return dt.datetime.fromisoformat(t).replace(tzinfo=dt.timezone.utc).timestamp()


def _utc(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M")


def _rain_from(series_path: str | None, t0: float):
    """Cumulative rain (mm) since t0 from an imerg.py series; None -> no rain."""
    if not series_path:
        return lambda t: 0.0
    rows = json.load(open(series_path))["rows"]
    edges = np.array([_epoch(t) - t0 for t, _ in rows] + [_epoch(rows[-1][0]) - t0 + 1800])
    cum = np.concatenate([[0.0], np.cumsum([r * 0.5 for _, r in rows])])
    at0 = float(np.interp(0.0, edges, cum))
    return lambda t: float(np.interp(t, edges, cum)) - at0


def run(aoi_id: str, gauges_path: str, rain_path: str | None, sites: list[str], hours: float,
        every_min: float) -> dict:
    from dryrun import storage
    from dryrun.contracts import ScenarioSpec, Storm
    from dryrun.sim import engine, solver

    aoi, inp = engine._load_inputs(ScenarioSpec(aoi_id=aoi_id, storm=Storm(total_mm=0, duration_h=1)))
    if not inp.inflows:
        raise SystemExit(f"{aoi_id} has no inflows layer")
    t0_utc = json.loads(storage.load_aoi_file(aoi_id, "inflows"))["t0_utc"]
    t0 = _epoch(t0_utc)
    cum_mm = _rain_from(rain_path, t0)
    times = list(np.arange(every_min * 60, hours * 3600 + 1, every_min * 60))
    clock = time.time()
    frames, led = solver.integrate(inp, times, lambda a, b: (cum_mm(b) - cum_mm(a)) / 1000)
    solver_s = time.time() - clock

    gauges = json.load(open(gauges_path))["sites"]
    w, s, e, n = aoi.grid.bounds_wgs84
    depth = np.stack([f for _, f in frames[1:]])
    out = {}
    for site in sites:
        g = gauges[site]
        r = int((n - g["lat"]) / (n - s) * aoi.grid.ny)
        c = int((g["lon"] - w) / (e - w) * aoi.grid.nx)
        win = depth[:, max(r - GAUGE_WINDOW, 0):r + GAUGE_WINDOW + 1, max(c - GAUGE_WINDOW, 0):c + GAUGE_WINDOW + 1]
        series = win.reshape(len(times), -1).max(axis=1)
        k = int(series.argmax())
        obs_t, obs_q = g["peak"]
        front = t0 + times[int(np.argmax(series >= 0.5 * series[k]))]
        tq = np.array([_epoch(t) for t, _ in g["rows"]])
        q = np.array([v for _, v in g["rows"]])
        i = int(np.argmax(q >= 0.5 * obs_q))  # first reading at half the peak, interpolated back
        obs_front = tq[i] if i == 0 else float(np.interp(0.5 * obs_q, q[i - 1:i + 1], tq[i - 1:i + 1]))
        out[site] = {"name": g["name"], "cell": [r, c],
                     "model_front_utc": _utc(front), "obs_front_utc": _utc(obs_front),
                     "front_error_min": round((front - obs_front) / 60),
                     "model_peak_utc": _utc(t0 + times[k]),
                     "model_peak_depth_m": round(float(series[k]), 2),
                     "obs_peak_utc": obs_t, "obs_peak_m3s": obs_q,
                     "peak_error_min": round((t0 + times[k] - _epoch(obs_t)) / 60)}
    if len(sites) >= 2:
        a, b = out[sites[0]], out[sites[-1]]
        out["front_travel_min"] = {k: round((_epoch(b[f"{k}_front_utc"]) - _epoch(a[f"{k}_front_utc"])) / 60)
                                   for k in ("model", "obs")}
    supplied = led["rain_volume_m3"] + led["inflow_volume_m3"]
    stored = float((frames[-1][1].astype(np.float64) - frames[0][1]).sum()) * aoi.grid.dx_m * aoi.grid.dy_m
    err = supplied - led["drained_volume_m3"] - led["infiltrated_volume_m3"] - led["boundary_outflow_m3"] - stored
    return {"aoi_id": aoi_id, "t0_utc": t0_utc, "solver_s": round(solver_s, 1),
            "rain_mm": round(cum_mm(hours * 3600), 1), "inflow_m3": round(led["inflow_volume_m3"]),
            "outflow_m3": round(led["boundary_outflow_m3"]),
            "mass_balance_pct": round(100 * err / supplied, 3) if supplied else 0.0, "gauges": out}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", required=True)
    ap.add_argument("--gauges", required=True, help="usgs.py output")
    ap.add_argument("--rain", help="imerg.py series over the AOI (optional)")
    ap.add_argument("--sites", nargs="+", required=True, help="upstream first, downstream last")
    ap.add_argument("--hours", type=float, default=12)
    ap.add_argument("--every-min", type=float, default=5)
    a = ap.parse_args()
    print(json.dumps(run(a.aoi, a.gauges, a.rain, a.sites, a.hours, a.every_min), indent=1))


if __name__ == "__main__":
    main()
