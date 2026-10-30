"""Score the Texas replay against observations of the 4 Jul 2025 Guadalupe flood (owner: Eng A).

Observations (one set, not two independent tests: FIMbench's extent is interpolated from the same marks):
- USGS STN event 357 "2025 July TX Flood": 224 high-water marks inside the AOI (usgs_hwm_event357_aoi.csv,
  from https://api.waterdata.usgs.gov/stnservices/hwms/filteredhwms/?event=357). elev_ft is NAVD88 feet;
  height_above_ground (ft) is the water depth at the mark, which needs no datum.
- FIMbench (University of Alabama / CIROH, CC-BY-4.0, doi:10.5281/zenodo.22961099) 10 m flooded/dry
  raster for tile HWM_20250702_20250706_991439W300048N, aggregated to model cells (flooded if >= half of
  the cell's valid 10 m pixels are), scored inside the benchmark's own AOI polygon.

Model: maximum depth over all frames of a done run (by default the demo replay). Water surface = DEM
(EGM2008) + depth; marks are converted NAVD88 -> EGM2008 with PROJ (about +1.02 m here).

  DRYRUN_STORAGE=... python evals/validation/texas_hwm.py --run r_cfef067dcc52b9c2 \\
      --fimbench data/_validation/fimbench/fimbench_BM.tif --fimbench-aoi data/_validation/fimbench/fimbench_AOI.gpkg
"""

from __future__ import annotations

import argparse
import csv
import json
import os

import numpy as np

FT = 0.3048
PRIMARY = ("Excellent", "Good", "Fair")  # hwm_quality_name prefixes used for the headline numbers
HERE = os.path.dirname(__file__)


def navd88_to_egm2008(lon, lat, h):
    import pyproj

    pyproj.network.set_network_enabled(True)
    t = pyproj.Transformer.from_crs("EPSG:6318+5703", "EPSG:4326+3855", always_xy=True)
    return np.asarray(t.transform(lon, lat, h)[2])


def _stats(err: np.ndarray) -> dict:
    if not err.size:
        return {"n": 0}
    return {"n": int(err.size), "mean_m": round(float(err.mean()), 2), "median_m": round(float(np.median(err)), 2),
            "mae_m": round(float(np.abs(err).mean()), 2), "rmse_m": round(float(np.sqrt((err ** 2).mean())), 2)}


def max_depth(run_id: str) -> np.ndarray:
    from dryrun import derived

    return derived.stack(run_id)[1].astype(np.float32).max(axis=0)


def score_hwms(aoi, dem, maxd, rows, window: int = 1, wet_m: float = 0.05) -> dict:
    w, s, e, n = aoi.grid.bounds_wgs84
    ny, nx = dem.shape
    lon = np.array([float(r["longitude_dd"]) for r in rows])
    lat = np.array([float(r["latitude_dd"]) for r in rows])
    obs = navd88_to_egm2008(lon, lat, np.array([float(r["elev_ft"]) for r in rows]) * FT)
    col = np.floor((lon - w) / (e - w) * nx).astype(int)
    row = np.floor((n - lat) / (n - s) * ny).astype(int)
    inside = (row >= 0) & (row < ny) & (col >= 0) & (col < nx)
    wse = np.where(maxd >= wet_m, dem + maxd, np.nan)
    near, win, dep = [], [], []
    for r, c, ok in zip(row, col, inside):
        if not ok:
            for lst in (near, win, dep):
                lst.append(np.nan)
            continue
        near.append(wse[r, c])
        p = wse[max(r - window, 0):r + window + 1, max(c - window, 0):c + window + 1]
        win.append(np.nanmax(p) if np.isfinite(p).any() else np.nan)  # marks sit on banks, a cell off the channel
        dep.append(maxd[r, c])
    near, win, dep = np.array(near), np.array(win), np.array(dep)
    hag = np.array([float(r["height_above_ground"]) * FT if r["height_above_ground"] else np.nan for r in rows])
    qual = np.array([r["hwm_quality_name"].split(":")[0] for r in rows])
    out = {"n_marks": len(rows), "n_inside_grid": int(inside.sum()), "datum_shift_m": round(float(np.median(
        obs - np.array([float(r["elev_ft"]) for r in rows]) * FT)), 3), "groups": {}}
    for name, sel in (("primary (Excellent/Good/Fair)", np.isin(qual, PRIMARY) & inside), ("all", inside)):
        wet = sel & np.isfinite(win)
        g = {"n": int(sel.sum()), "model_dry_at_mark": int((sel & ~np.isfinite(win)).sum()),
             "wse_error_nearest_cell": _stats((near - obs)[sel & np.isfinite(near)]),
             "wse_error_3x3_max": _stats((win - obs)[wet])}
        d = sel & np.isfinite(hag)
        g["depth_vs_height_above_ground"] = {**_stats((dep - hag)[d]),
                                             "obs_median_m": round(float(np.median(hag[d])), 2) if d.any() else None,
                                             "model_median_m": round(float(np.median(dep[d])), 2) if d.any() else None}
        out["groups"][name] = g
    return out


def score_extent(aoi, maxd, bm_path: str, aoi_path: str, thresholds=(0.05, 0.15, 0.3)) -> dict:
    import geopandas as gpd
    import rasterio
    from rasterio.features import rasterize
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject

    ny, nx = maxd.shape
    dst_t = from_bounds(*aoi.grid.bounds_wgs84, nx, ny)
    with rasterio.open(bm_path) as src:
        a = src.read(1).astype(np.float32)
        valid = (a != src.nodata) & (a >= 0) if src.nodata is not None else a >= 0
        flooded = np.where(valid, (a == 1).astype(np.float32), 0)
        frac_f = np.zeros((ny, nx), np.float32)
        frac_v = np.zeros((ny, nx), np.float32)
        for arr, out in ((flooded, frac_f), (valid.astype(np.float32), frac_v)):
            reproject(arr, out, src_transform=src.transform, src_crs=src.crs, dst_transform=dst_t,
                      dst_crs="EPSG:4326", resampling=Resampling.average)
    poly = gpd.read_file(aoi_path).to_crs("EPSG:4326")
    inside = rasterize(poly.geometry, out_shape=(ny, nx), transform=dst_t, fill=0, default_value=1).astype(bool)
    scored = inside & (frac_v >= 0.5)
    obs = scored & (frac_f >= 0.5 * frac_v)
    res = {"cells_scored": int(scored.sum()), "obs_flooded_cells": int(obs.sum()),
           "cell_km2": round(aoi.grid.dx_m * aoi.grid.dy_m / 1e6, 5), "by_threshold": {}}
    for th in thresholds:
        mod = scored & (maxd >= th)
        tp, fp, fn = int((mod & obs).sum()), int((mod & ~obs).sum()), int((~mod & obs & scored).sum())
        res["by_threshold"][str(th)] = {"csi": round(tp / max(tp + fp + fn, 1), 3), "pod": round(tp / max(tp + fn, 1), 3),
                                        "far": round(fp / max(tp + fp, 1), 3), "bias": round((tp + fp) / max(tp + fn, 1), 3),
                                        "tp": tp, "fp": fp, "fn": fn}
    return res


def run(run_id: str, bm: str | None, bm_aoi: str | None, hwm_csv: str) -> dict:
    from dryrun import storage

    m = storage.load_run(run_id)
    aoi = storage.load_aoi(m.scenario.aoi_id)
    dem = storage.load_raster(aoi.aoi_id, "dem").astype(np.float64)
    maxd = max_depth(run_id)
    rows = list(csv.DictReader(open(hwm_csv)))
    out = {"run_id": run_id, "aoi_id": aoi.aoi_id, "hwm": score_hwms(aoi, dem, maxd, rows)}
    if bm and bm_aoi:
        out["extent"] = score_extent(aoi, maxd, bm, bm_aoi)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="r_cfef067dcc52b9c2")
    ap.add_argument("--fimbench")
    ap.add_argument("--fimbench-aoi")
    ap.add_argument("--hwm", default=os.path.join(HERE, "usgs_hwm_event357_aoi.csv"))
    a = ap.parse_args()
    print(json.dumps(run(a.run, a.fimbench, a.fimbench_aoi, a.hwm), indent=1))


if __name__ == "__main__":
    main()
