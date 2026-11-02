"""Score the Queens Ida runs against USGS high-water marks (owner: Eng A).

USGS STN event 312 "2021 Ida": 32 marks at 16 sites inside the nyc-queens box (usgs_hwm_event312_queens.csv, from
https://api.waterdata.usgs.gov/stnservices/hwms/filteredhwms/?event=312, cut to the AOI bounds). elev_ft is NAVD88
feet; height_above_ground (ft) is the water depth at the mark. Many marks are on basement doors, garage ramps and
sunken entrances, below the street a 15 m cell stands for, so the water surface is the fairer test.

Per case (the drainage validation's Ida cases, 181 mm / 4.5 h centre-peaked):
- water surface at the marks (NAVD88 -> EGM2008 with PROJ): at the mark's own cell, a dry cell counting as its
  ground, and texas_hwm.score_hwms's 3x3 max over wet cells (>= 0.15 m);
- depth at the mark's own cell vs height above ground;
- hit rate: the share of sites with >= 0.15 m within 30 m, lift over random road cells (nyc311_ida.score). Marks
  at one site count once.

  DRYRUN_SIM_BACKEND=solver python evals/validation/queens_hwm.py
"""

from __future__ import annotations

import csv
import json
import os

import numpy as np

HERE = os.path.dirname(__file__)
CSV = os.path.join(HERE, "usgs_hwm_event312_queens.csv")


def marks(path: str = CSV) -> list[dict]:
    return list(csv.DictReader(open(path)))


def sites(rows: list[dict]) -> list[dict]:
    """One point per site (the mean of its marks), in nyc311_ida's row shape."""
    by: dict[str, list[dict]] = {}
    for r in rows:
        by.setdefault(r["site_id"], []).append(r)
    return [{"longitude": str(np.mean([float(r["longitude_dd"]) for r in g])),
             "latitude": str(np.mean([float(r["latitude_dd"]) for r in g])), "surface": "1"} for g in by.values()]


def score(run_id: str, rows: list[dict]) -> dict:
    from dryrun import storage
    from evals.validation import nyc311_ida
    from evals.validation.texas_hwm import FT, _stats, navd88_to_egm2008, score_hwms

    m = storage.load_run(run_id)
    aoi = storage.load_aoi(m.scenario.aoi_id)
    dem = storage.load_raster(aoi.aoi_id, "dem").astype(np.float64)
    maxd = storage.load_depth(run_id, "max_depth.npy").astype(np.float64)
    hw = score_hwms(aoi, dem, maxd, rows, wet_m=0.15)["groups"]["all"]
    hit = nyc311_ida.score(run_id, sites(rows))["by_radius"]["30"]
    lon = np.array([float(r["longitude_dd"]) for r in rows])
    lat = np.array([float(r["latitude_dd"]) for r in rows])
    obs = navd88_to_egm2008(lon, lat, np.array([float(r["elev_ft"]) for r in rows]) * FT)
    rr, cc = nyc311_ida._cells(aoi.grid, lon, lat)
    own = dem[rr, cc] + maxd[rr, cc] - obs  # the mark's own cell; a dry cell counts as its ground
    return {"marks": hw["n"], "dry_at_mark": hw["model_dry_at_mark"], "wse_3x3": hw["wse_error_3x3_max"],
            "wse_own_cell": {**_stats(own), "below_by_0.3m": int((own < -0.3).sum())},
            "depth": hw["depth_vs_height_above_ground"], "sites_hit_30m": hit}


def main() -> None:
    from dryrun.contracts import Drainage, DrainUpgrade
    from evals.validation.drainage import IDA, _run

    rows = marks()
    cases = [
        ("fixed sink 13 mm/h", "nyc-queens-v0", None, ()),
        ("fixed sink, sewers full (v0 hero)", "nyc-queens-v0", None, (DrainUpgrade(capacity_factor=0),)),
        ("sewers 1.5 in/h (v1 default)", "nyc-queens-v1", None, ()),
        ("sewers 1.75 in/h (5-year)", "nyc-queens-v1", Drainage(return_period_yr=5), ()),
        ("sewers 0.75 in/h (half)", "nyc-queens-v1", Drainage(capacity_mm_h=19.05), ()),
        ("sewers, outfalls blocked (v1 hero)", "nyc-queens-v1", Drainage(outfall="blocked"), ()),
        ("sewers, 50 % clogged", "nyc-queens-v1", Drainage(blockage_pct=50), ()),
    ]
    out = []
    for label, aoi_id, dr, iv in cases:
        m = _run(aoi_id, IDA, dr, iv)
        out.append({"case": label, "run_id": m.run_id, "flooded_km2": m.stats.flooded_area_km2, **score(m.run_id, rows)})
        print(json.dumps(out[-1]), flush=True)


if __name__ == "__main__":
    main()
