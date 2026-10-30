"""Lidar DEM onto an AOI grid (owner: Eng A). For AOIs with bare-earth lidar (NYC: the 2017 NYC lidar in USGS 3DEP).

Fetches the USGS 3DEP elevation service at 1/9 arc-second (~3 m) over the grid, aggregates each model cell with
the first quartile (Resampling.q1): lower than the mean so street dips survive at 15 m, but not the single lowest
pixel, which picks up kerb drops and lidar pits. Then NAVD88 -> EGM2008 with PROJ, so heights match the other
AOIs (GLO-30 is EGM2008) and terrain_match's geoid step.

  python -m dryrun.pipeline.lidar_dem --raw data/raw/nyc-queens        # reads grid.json, writes dem.npy
"""

from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
FINE_ARCSEC = 1 / 9
PAD_DEG = 0.001


def fetch_3dep(bounds: tuple[float, float, float, float], out: Path) -> Path:
    w, s, e, n = bounds[0] - PAD_DEG, bounds[1] - PAD_DEG, bounds[2] + PAD_DEG, bounds[3] + PAD_DEG
    step = FINE_ARCSEC / 3600
    q = dict(bbox=f"{w},{s},{e},{n}", bboxSR=4326, imageSR=4326, size=f"{round((e - w) / step)},{round((n - s) / step)}",
             format="tiff", pixelType="F32", interpolation="RSP_NearestNeighbor", f="image")
    out.write_bytes(urllib.request.urlopen(SERVICE + "?" + urllib.parse.urlencode(q), timeout=600).read())
    return out


def navd88_to_egm2008(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """EGM2008 height of the NAVD88 zero at each point (add to a NAVD88 height)."""
    import pyproj

    pyproj.network.set_network_enabled(True)
    t = pyproj.Transformer.from_crs("EPSG:6318+5703", "EPSG:4326+3855", always_xy=True)
    return np.asarray(t.transform(lon, lat, np.zeros_like(lon))[2])


def to_grid(src_tif: Path, transform: tuple, nx: int, ny: int) -> np.ndarray:
    sx, _, w, _, sy, n = transform
    lon = w + (np.arange(nx) + 0.5) * sx
    lat = n + (np.arange(ny) + 0.5) * sy
    X, Y = np.meshgrid(lon, lat)
    # before any GDAL warp: once rasterio has run a warp in this process, PROJ's network grids come back inf
    shift = navd88_to_egm2008(X[::8, ::8].ravel(), Y[::8, ::8].ravel()).reshape(X[::8, ::8].shape)
    if not np.isfinite(shift).all():
        raise SystemExit("NAVD88 -> EGM2008 offset unavailable (PROJ network grids)")
    shift = np.kron(shift, np.ones((8, 8)))[:ny, :nx]  # the geoid offset varies by mm over 8 cells

    import rasterio
    from affine import Affine
    from rasterio.warp import Resampling, reproject

    dst = np.full((ny, nx), np.nan, np.float32)
    with rasterio.open(src_tif) as src:
        reproject(src.read(1), dst, src_transform=src.transform, src_crs=src.crs,
                  dst_transform=Affine(*transform), dst_crs="EPSG:4326", resampling=Resampling.q1,
                  src_nodata=src.nodata, dst_nodata=np.nan)
    return (dst + shift).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, help="raw folder with grid.json")
    a = ap.parse_args()
    raw = Path(a.raw)
    g = json.loads((raw / "grid.json").read_text())
    tif = raw / "dem_3dep_3m_navd88.tif"
    if not tif.exists():
        fetch_3dep(tuple(g["bounds_wgs84"]), tif)
    dem = to_grid(tif, tuple(g["transform"]), g["nx"], g["ny"])
    if not np.isfinite(dem).all():
        raise SystemExit(f"{int((~np.isfinite(dem)).sum())} cells without lidar")
    np.save(raw / "dem.npy", dem)
    print(json.dumps({"shape": dem.shape, "min": float(dem.min()), "max": float(dem.max()),
                      "mean": round(float(dem.mean()), 2)}))


if __name__ == "__main__":
    main()
