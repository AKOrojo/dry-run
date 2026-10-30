"""Validate the drain/sewer model (contract 0.8.0) against observations (owner: Eng A).

queens  Hurricane Ida over Queens: the fixed sink (nyc-queens-v0) against the sewer model (nyc-queens-v1).
        - 311 street-flood reports (nyc311_ida.score: hit within 30 m, lift over random road cells);
        - sewer-backup and basement reports against the sewer zones the run filled (>= 95 % at some frame): share of
          those reports inside a full zone, over the share of road cells inside one (lift);
        - the NYC DEP Stormwater Flood Map "Moderate, current sea level" (2.13 in/h): the city's own model of
          where >= 4 in of water collects at that rate. Our run: 54.1 mm in 1 h; wet = max depth >= 0.10 m on land.
          Hit rate = DEP flooded cells we wet, false alarm = our wet cells outside DEP, CSI.
lagos   the built-up loss (6 mm/h in lagos-lekki-v2) stood in for unmapped drains; with the drain network it is
        refitted on the same Sentinel-1 drain-down (calibrate_builtup.run).

  DRYRUN_SIM_BACKEND=solver python evals/validation/drainage.py queens
  DRYRUN_SIM_BACKEND=solver python evals/validation/drainage.py lagos --rates 2 3 4 6
"""

from __future__ import annotations

import argparse
import json
import os

import numpy as np

HERE = os.path.dirname(__file__)
DEP_MODERATE = ("data/raw/nyc-queens/drains/NYC_Stormwater_Flood_Map_Moderate_Flood_2_13_inches_per_hr_with_"
                "Current_Sea_Levels_box.geojson")
DEP_WET_M = 0.10  # DEP maps flooding of 4 in and more
IDA = dict(total_mm=181, duration_h=4.5, pattern="center_peaked")
FULL_PCT = 95


def _run(aoi_id: str, storm: dict, drainage=None, interventions=(), sim_hours: float = 8):
    from dryrun.contracts import ScenarioSpec, Storm
    from dryrun.sim import engine

    spec = ScenarioSpec(aoi_id=aoi_id, storm=Storm(**storm), drainage=drainage, interventions=list(interventions),
                        sim_hours=sim_hours)
    m = engine.run_scenario(spec)
    if m.status.value != "done":
        raise RuntimeError(m.error)
    return m


def dep_mask(grid, path: str) -> np.ndarray:
    """DEP flooded polygons (shallow and deep) -> cells whose centre lies inside."""
    import shapely
    from shapely.geometry import shape

    g = json.load(open(path))
    geom = shapely.union_all([shape(f["geometry"]) for f in g["features"]])
    w, s, e, n = grid.bounds_wgs84
    lon = w + (np.arange(grid.nx) + 0.5) * (e - w) / grid.nx
    lat = n - (np.arange(grid.ny) + 0.5) * (n - s) / grid.ny
    X, Y = np.meshgrid(lon, lat)
    return shapely.contains_xy(geom, X.ravel(), Y.ravel()).reshape(grid.ny, grid.nx)


def dep_score(run_id: str, aoi_id: str, dep: np.ndarray) -> dict:
    from dryrun import storage

    land = ~(storage.load_raster(aoi_id, "exclude_mask") > 0.5) & ~(storage.load_raster(aoi_id, "boundary_mask") > 0.5)
    wet = (storage.load_depth(run_id, "max_depth.npy") >= DEP_WET_M) & land
    obs = dep & land
    hit, miss, fa = (wet & obs).sum(), (~wet & obs).sum(), (wet & ~obs).sum()
    return {"dep_cells": int(obs.sum()), "model_wet_cells": int(wet.sum()), "hit_rate": round(hit / max(obs.sum(), 1), 3),
            "false_alarm_ratio": round(fa / max(wet.sum(), 1), 3), "csi": round(hit / max(hit + miss + fa, 1), 3)}


def backup_score(m, rows: list[dict]) -> dict | None:
    """Sewer-backup / basement reports inside zones the run filled, over road cells inside them."""
    from dryrun import storage
    from dryrun.sim.exposure import edge_arrays
    from evals.validation.nyc311_ida import _cells

    if m.drain_fill is None:
        return None
    fill = json.loads(storage._read_bytes("runs", f"{m.run_id}/{m.drain_fill}"))
    full = {int(i.split(":")[1]) for i, k, col in zip(fill["ids"], fill["kind"], zip(*fill["fill_pct"]))
            if k == "sewer_zone" and max(col) >= FULL_PCT}
    zones = storage.load_raster(m.scenario.aoi_id, "sewer_zones").astype(np.int64)
    in_full = np.isin(zones, list(full))
    g = storage.load_aoi(m.scenario.aoi_id).grid
    sel = [x for x in rows if x["surface"] != "1"]
    r, c = _cells(g, np.array([float(x["longitude"]) for x in sel]), np.array([float(x["latitude"]) for x in sel]))
    ok = (r >= 0) & (r < g.ny) & (c >= 0) & (c < g.nx)
    share = float(in_full[r[ok], c[ok]].mean()) if ok.any() else 0.0
    road = np.unique(edge_arrays(m.scenario.aoi_id).flat)
    base = float(in_full.ravel()[road].mean())
    return {"zones_full": len(full), "zones": sum(k == "sewer_zone" for k in fill["kind"]), "reports": int(ok.sum()),
            "in_full_zone": round(share, 3), "road_cells_in_full_zone": round(base, 3),
            "lift": round(share / base, 2) if base > 0 else None}


def queens(dep_path: str = DEP_MODERATE) -> list[dict]:
    from dryrun import storage
    from dryrun.contracts import Drainage, DrainUpgrade
    from evals.validation import nyc311_ida

    rows = nyc311_ida.reports()
    cases = [
        ("fixed sink 13 mm/h", "nyc-queens-v0", IDA, None, ()),
        ("fixed sink, sewers full (hero)", "nyc-queens-v0", IDA, None, (DrainUpgrade(capacity_factor=0),)),
        ("sewers 1.5 in/h (default)", "nyc-queens-v1", IDA, None, ()),
        ("sewers 1.75 in/h (5-year)", "nyc-queens-v1", IDA, Drainage(return_period_yr=5), ()),
        ("sewers 0.75 in/h (half)", "nyc-queens-v1", IDA, Drainage(capacity_mm_h=19.05), ()),
        ("sewers, outfalls blocked", "nyc-queens-v1", IDA, Drainage(outfall="blocked"), ()),
        ("sewers, 50 % clogged", "nyc-queens-v1", IDA, Drainage(blockage_pct=50), ()),
    ]
    out = []
    for label, aoi_id, storm, dr, iv in cases:
        m = _run(aoi_id, storm, dr, iv)
        sc = nyc311_ida.score(m.run_id, rows)["by_radius"]["30"]
        row = {"case": label, "run_id": m.run_id, "flooded_km2": m.stats.flooded_area_km2,
               "buildings": m.stats.buildings_flooded, "elapsed_s": m.elapsed_s,
               "street_hit": sc["surface"]["hit_rate"], "street_ci": sc["surface"]["ci95"],
               "road_baseline": sc["road_baseline"], "street_lift": sc["surface"]["lift"],
               "backup": backup_score(m, rows), "sewer_peak_pct": m.stats.drain_peak_full_pct,
               "overflow": [m.stats.drain_surcharge_start_t_s, m.stats.drain_surcharge_end_t_s]}
        out.append(row)
        print(json.dumps(row), flush=True)
    dep = dep_mask(storage.load_aoi("nyc-queens-v1").grid, dep_path)
    for label, aoi_id, dr in (("fixed sink 13 mm/h", "nyc-queens-v0", None),
                              ("sewers 1.5 in/h (default)", "nyc-queens-v1", None),
                              ("sewers 1.75 in/h (5-year)", "nyc-queens-v1", Drainage(return_period_yr=5))):
        m = _run(aoi_id, dict(total_mm=54.1, duration_h=1, pattern="uniform"), dr, (), sim_hours=3)
        row = {"case": f"DEP moderate 2.13 in/h: {label}", "run_id": m.run_id, "flooded_km2": m.stats.flooded_area_km2,
               **dep_score(m.run_id, aoi_id, dep)}
        out.append(row)
        print(json.dumps(row), flush=True)
    return out


def lagos(rates: list[float]) -> list[dict]:
    from evals.validation import calibrate_builtup

    calibrate_builtup.BUILT_UP_MM_H = 6.0  # v2/v3 built-up value (WorldCover 50)
    return calibrate_builtup.run("lagos-lekki-v3", rates)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["queens", "lagos"])
    ap.add_argument("--rates", type=float, nargs="+", default=[2, 3, 4, 6])
    ap.add_argument("--dep", default=DEP_MODERATE, help="DEP Moderate stormwater flood map GeoJSON (clipped)")
    a = ap.parse_args()
    queens(a.dep) if a.what == "queens" else lagos(a.rates)


if __name__ == "__main__":
    main()
