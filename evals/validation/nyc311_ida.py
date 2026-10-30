"""Score the Hurricane Ida replays over Queens against NYC 311 flood reports (owner: Eng A).

Reports: 311 service requests created 1 Sep 2021 18:00 to 2 Sep 06:00 in the nyc-queens-v0 box
(nyc311_ida_queens.csv, NYC Open Data erm2-nwe9). `surface` = 1 for street flooding, catch basin and manhole
overflow (water on the street, which a surface model can show); 0 for sewer backup and basement water (often
water rising through the building's own pipes, which the model does not represent).

A report is a hit when the run's maximum depth reaches THRESHOLD_M in any land cell within R metres. Reports
are geocoded to street addresses, so the baseline is the same test at random road cells (roads_graph), not at
random land: lift = hit rate / road baseline. A 95 % bootstrap interval is given for the hit rate.

  python evals/validation/nyc311_ida.py r_48aae11b5d8514ed [more run ids]
"""

from __future__ import annotations

import argparse
import csv
import json
import os

import numpy as np

HERE = os.path.dirname(__file__)
AOI = "nyc-queens-v0"
THRESHOLD_M = 0.15
RADII_M = (30.0, 50.0)
NULL_SAMPLES = 5000
BOOT = 2000
SEED = 7


def reports(path: str | None = None) -> list[dict]:
    return list(csv.DictReader(open(path or os.path.join(HERE, "nyc311_ida_queens.csv"))))


def _cells(grid, lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    w, s, e, n = grid.bounds_wgs84
    r = ((n - lat) / (n - s) * grid.ny).astype(int)
    c = ((lon - w) / (e - w) * grid.nx).astype(int)
    return r, c


def near_max(depth: np.ndarray, land: np.ndarray, r: np.ndarray, c: np.ndarray, rad_cells: tuple[int, int]):
    """Max land depth in the ellipse of radius (rows, cols) around each (r, c)."""
    ry, rx = rad_cells
    dy, dx = np.mgrid[-ry:ry + 1, -rx:rx + 1]
    keep = (dy / max(ry, 1)) ** 2 + (dx / max(rx, 1)) ** 2 <= 1.0
    dy, dx = dy[keep], dx[keep]
    d = np.where(land, depth, 0.0)
    rr = np.clip(r[:, None] + dy[None], 0, depth.shape[0] - 1)
    cc = np.clip(c[:, None] + dx[None], 0, depth.shape[1] - 1)
    return d[rr, cc].max(axis=1)


def score(run_id: str, rows: list[dict] | None = None) -> dict:
    from dryrun import storage
    from dryrun.sim.exposure import edge_arrays

    aoi = storage.load_aoi(AOI)
    g = aoi.grid
    land = ~(storage.load_raster(AOI, "exclude_mask") > 0.5) & ~(storage.load_raster(AOI, "boundary_mask") > 0.5)
    depth = storage.load_depth(run_id, "max_depth.npy").astype(np.float64)
    rows = rows if rows is not None else reports()
    lon = np.array([float(x["longitude"]) for x in rows])
    lat = np.array([float(x["latitude"]) for x in rows])
    surface = np.array([x["surface"] == "1" for x in rows])
    r, c = _cells(g, lon, lat)
    inside = (r >= 0) & (r < g.ny) & (c >= 0) & (c < g.nx)
    road = np.unique(edge_arrays(AOI).flat)
    road = road[land.ravel()[road]]
    rng = np.random.default_rng(SEED)
    pick = road[rng.integers(len(road), size=NULL_SAMPLES)]
    nr, nc = np.divmod(pick, g.nx)
    out = {"run_id": run_id, "threshold_m": THRESHOLD_M, "reports_in_box": int(inside.sum()), "by_radius": {}}
    for rad in RADII_M:
        cells = (int(round(rad / g.dy_m)), int(round(rad / g.dx_m)))
        hit = near_max(depth, land, r[inside], c[inside], cells) >= THRESHOLD_M
        base = float((near_max(depth, land, nr, nc, cells) >= THRESHOLD_M).mean())
        res = {"road_baseline": round(base, 3)}
        for name, sel in (("surface", surface[inside]), ("sewer_or_basement", ~surface[inside])):
            h = hit[sel]
            if not len(h):
                continue
            boot = rng.choice(h, size=(BOOT, len(h))).mean(axis=1)
            rate = float(h.mean())
            res[name] = {"n": int(len(h)), "hit_rate": round(rate, 3),
                         "ci95": [round(float(np.percentile(boot, 2.5)), 3), round(float(np.percentile(boot, 97.5)), 3)],
                         "lift": round(rate / base, 2) if base > 0 else None}
        out["by_radius"][str(int(rad))] = res
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_ids", nargs="+")
    a = ap.parse_args()
    for rid in a.run_ids:
        print(json.dumps(score(rid)), flush=True)


if __name__ == "__main__":
    main()
