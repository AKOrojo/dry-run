"""Raw layer download for a real AOI (owner: Eng D). Offline only, NEVER at request time.

GRID (everyone): EPSG:4326, 1 arc-second cells (crsTransform [1/3600, 0, W, 0, -1/3600, N]),
~30.7 m x 30.5 m at Lagos. That is Copernicus GLO-30's native grid, so the DEM needs no
resampling, and bounds_wgs84 is an exact rectangle for Cesium/polygon masks. AOI W/N snapped
to whole arc-seconds.

PRIMARY path (no Earth Engine needed; approval can take >1 day):
  dem         Copernicus GLO-30 COGs, AWS open data bucket `copernicus-dem-30m`
  landcover   ESA WorldCover 10 m v200, AWS open data `esa-worldcover` -> MODE to the grid
  water       JRC Global Surface Water occurrence tiles (direct download) -> boundary/exclude masks
  population  WorldPop 100 m (direct download) -> SUM-resampled (people per cell)
Earth Engine is used ONLY for the Sentinel-1 pre/post validation scene (Thu), if registered.

Outputs go to a scratch folder; build_layers.py (Eng A) turns them into the serving layers.
This offline scratch I/O is intentionally separate from serving storage. Rasterio and httpx
are lazy dependencies. Remote COGs use /vsicurl/ window reads, never whole-file downloads.
Each layer has a local-path-compatible resampler for offline verification. Population totals
are checked against fractional source pixels over the snapped output extent (2% tolerance).
Outputs: dem/worldcover/jrc_occurrence/population .npy and GeoTIFF, plus grid.json with
GridSpec fields, affine transform and source attribution. Population nodata becomes zero;
its output nodata_fraction is zero because those cells are valid zero population.
The optional vector downloads stream to disk and resume with HTTP Range; they are large.
Run: python -m dryrun.pipeline.ee_export --aoi-id ID --bbox W S E N --out data/raw/ID [--vectors].
"""


from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from dryrun.contracts import GridSpec

STEP = 1 / 3600
WORLDPOP_YEAR = 2025
WORLDPOP_URL = (
    "https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/"
    f"{WORLDPOP_YEAR}/NGA/v1/100m/constrained/nga_pop_{WORLDPOP_YEAR}_CN_100m_R2025A_v1.tif"
)
# data.worldpop.org ignores Range (answers 200 with the whole file, checked 2026-10-29), so /vsicurl/ fails.
NO_RANGE_READS = {"population"}
SOURCES = {
    "dem": {
        "url": "https://copernicus-dem-30m.s3.amazonaws.com/{tile}/{tile}.tif",
        "credit": "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH "
                  "2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
        "licence": "Copernicus DEM licence (free and open use)",
    },
    "worldcover": {
        "url": "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
               "ESA_WorldCover_10m_2021_v200_{tile}_Map.tif",
        "credit": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) "
                  "processed by ESA WorldCover consortium",
        "licence": "CC BY 4.0",
    },
    "jrc_occurrence": {
        "url": "https://s3.waw4-1.cloudferro.com/swift/v1/global-surface-water/download2024/"
               "Aggregated/VER1-5/occurrence/occurrence_{tile}_v1_5_2024.tif",
        "credit": "Source: EC JRC/Google; Pekel et al. 2016",
        "licence": "Copernicus free and open data policy",
    },
    "population": {
        "url": WORLDPOP_URL,
        "credit": "WorldPop (www.worldpop.org), University of Southampton. R2025A v1, DOI:10.5258/SOTON/WP00839",
        "licence": "CC BY 4.0",
    },
    "buildings": {
        "url": "https://storage.googleapis.com/open-buildings-data/v3/"
               "polygons_s2_level_6_gzip_no_header/103b_buildings.csv.gz",
        "credit": "Google Open Buildings v3 (CSV without header)",
        "licence": "CC BY 4.0",
    },
    "osm": {
        "url": "https://download.geofabrik.de/africa/nigeria-latest.osm.pbf",
        "credit": "© OpenStreetMap contributors; extract by Geofabrik",
        "licence": "ODbL 1.0",
    },
}


def grid_for_bbox(bbox_wgs84: tuple[float, float, float, float]) -> tuple[GridSpec, tuple]:
    """Cover a non-wrapping WGS84 bbox with whole arc-second cells."""
    w, s, e, n = bbox_wgs84
    if not all(math.isfinite(v) for v in bbox_wgs84) or not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise ValueError("expected finite W S E N within WGS84, without antimeridian crossing")
    west = math.floor(w * 3600)
    north = math.ceil(n * 3600)
    nx = math.ceil(e * 3600) - west
    ny = north - math.floor(s * 3600)
    bounds = (west / 3600, (north - ny) / 3600, (west + nx) / 3600, north / 3600)
    dx = STEP * 111320 * math.cos(math.radians((s + n) / 2))
    dy = STEP * 110574
    grid = GridSpec(nx=nx, ny=ny, dx_m=dx, dy_m=dy, cell_size_m=math.sqrt(dx * dy), bounds_wgs84=bounds)
    return grid, (STEP, 0, bounds[0], 0, -STEP, bounds[3])


def source_urls(layer: str, bounds: tuple) -> list[str]:
    """Enumerate tiles intersecting the snapped output extent."""
    if layer == "population":
        return [WORLDPOP_URL]
    w, s, e, n = bounds
    size = {"dem": 1, "worldcover": 3, "jrc_occurrence": 10}[layer]
    urls = []
    for lat in range(math.floor(s / size) * size, math.ceil(n / size) * size, size):
        for lon in range(math.floor(w / size) * size, math.ceil(e / size) * size, size):
            ns, ew = "N" if lat >= 0 else "S", "E" if lon >= 0 else "W"
            if layer == "dem":
                tile = f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"
            elif layer == "worldcover":
                tile = f"{ns}{abs(lat):02d}{ew}{abs(lon):03d}"
            else:
                top = lat + size
                tile = f"{abs(lon)}{ew}_{abs(top)}{'N' if top >= 0 else 'S'}"
            urls.append(SOURCES[layer]["url"].format(tile=tile))
    return urls


def _resample(path: str, grid: GridSpec, transform: tuple, layer: str) -> tuple[np.ndarray, float | None]:
    """Read only the intersecting source window; GDAL uses HTTP range reads for URLs."""
    import rasterio
    from affine import Affine
    from rasterio.warp import Resampling, reproject, transform_bounds
    from rasterio.windows import Window, from_bounds

    nodata = {"dem": np.nan, "worldcover": 0, "jrc_occurrence": 255, "population": 0}[layer]
    out = np.full((grid.ny, grid.nx), nodata, np.float32)
    method = {"dem": Resampling.nearest, "worldcover": Resampling.mode,
              "jrc_occurrence": Resampling.nearest, "population": Resampling.sum}[layer]
    remote = path.startswith(("https://", "http://"))
    with rasterio.Env(GDAL_HTTP_USERAGENT="dryrun-pipeline/0.1", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open("/vsicurl/" + path if remote else path) as src:
            bounds = transform_bounds(grid.crs, src.crs, *grid.bounds_wgs84)
            window = from_bounds(*bounds, transform=src.transform)
            left, top = math.floor(window.col_off), math.floor(window.row_off)
            right, bottom = math.ceil(window.col_off + window.width), math.ceil(window.row_off + window.height)
            left, top = max(0, left), max(0, top)
            right, bottom = min(src.width, right), min(src.height, bottom)
            if right <= left or bottom <= top:
                return out, 0.0 if layer == "population" else None
            win = Window(left, top, right - left, bottom - top)
            data = src.read(1, window=win, masked=True).astype(np.float32)
            source = data.filled(np.nan)
            # JRC's sentinel is a value on the output, including at source nodata pixels.
            if layer == "jrc_occurrence":
                source = data.filled(255)
            reproject(source, out, src_transform=src.window_transform(win), src_crs=src.crs,
                      src_nodata=255 if layer == "jrc_occurrence" else np.nan, dst_transform=Affine(*transform), dst_crs=grid.crs,
                      dst_nodata=nodata, resampling=method)
            total = None
            if layer == "population":
                # Fractional edge pixels give the source total over exactly the output box.
                cols = np.arange(left, right)
                rows = np.arange(top, bottom)
                x = np.clip(np.minimum(cols + 1, window.col_off + window.width) -
                            np.maximum(cols, window.col_off), 0, 1)
                y = np.clip(np.minimum(rows + 1, window.row_off + window.height) -
                            np.maximum(rows, window.row_off), 0, 1)
                total = float(np.sum(data.filled(0).astype(np.float64) * y[:, None] * x[None, :]))
                actual = float(out.sum(dtype=np.float64))
                if not math.isclose(actual, total, rel_tol=0.02, abs_tol=1e-5):
                    raise ValueError(f"population conservation failed: output={actual}, source={total}")
    return out, total


def resample_dem(path: str, grid: GridSpec, transform: tuple) -> np.ndarray:
    return _resample(str(path), grid, transform, "dem")[0]


def resample_worldcover(path: str, grid: GridSpec, transform: tuple) -> np.ndarray:
    return _resample(str(path), grid, transform, "worldcover")[0].astype(np.uint8)


def resample_jrc(path: str, grid: GridSpec, transform: tuple) -> np.ndarray:
    return _resample(str(path), grid, transform, "jrc_occurrence")[0]


def resample_population(path: str, grid: GridSpec, transform: tuple) -> np.ndarray:
    return _resample(str(path), grid, transform, "population")[0]


def download(aoi_id: str, bbox_wgs84: tuple[float, float, float, float], out_dir: str) -> dict:
    """Write offline scratch files directly; these are not serving storage objects."""
    import rasterio
    from affine import Affine

    grid, transform = grid_for_bbox(bbox_wgs84)
    folder = Path(out_dir)
    folder.mkdir(parents=True, exist_ok=True)
    report = {"aoi_id": aoi_id, "layers": {}}
    sources = {}
    for layer in ("dem", "worldcover", "jrc_occurrence", "population"):
        urls = source_urls(layer, grid.bounds_wgs84)
        fill = {"dem": np.nan, "worldcover": 0, "jrc_occurrence": 255, "population": 0}[layer]
        array = np.full((grid.ny, grid.nx), fill, np.float32)
        for url in urls:
            if layer in NO_RANGE_READS and url.startswith(("https://", "http://")):  # cache once, read locally
                url = fetch_file(url, str(folder / "_src" / url.rsplit("/", 1)[1]))
            tile, _ = _resample(url, grid, transform, layer)
            valid = np.isfinite(tile) if layer == "dem" else tile != fill
            array[valid] = tile[valid]
        missing = ~np.isfinite(array) if layer == "dem" else array == fill
        if layer == "population":
            missing = np.zeros(array.shape, dtype=bool)
        if layer == "worldcover":
            array = array.astype(np.uint8)
        np.save(folder / f"{layer}.npy", array)
        with rasterio.open(folder / f"{layer}.tif", "w", driver="GTiff", width=grid.nx, height=grid.ny,
                           count=1, dtype=array.dtype, crs=grid.crs, transform=Affine(*transform),
                           nodata=fill, compress="deflate") as dst:
            dst.write(array, 1)
        values = array[~missing]
        report["layers"][layer] = {"shape": list(array.shape), "min": float(values.min()) if values.size else None,
                                   "max": float(values.max()) if values.size else None,
                                   "nodata_fraction": float(missing.mean()), "urls": urls}
        sources[layer] = {**SOURCES[layer], "urls": urls}
    metadata = {**grid.model_dump(mode="json"), "transform": transform, "sources": sources, "aoi_id": aoi_id}
    (folder / "grid.json").write_text(json.dumps(metadata, indent=2))
    return report


def fetch_file(url: str, dest: str) -> str:
    """Stream a vector file, resuming only when the server honours the requested range."""
    import httpx

    path = Path(dest)
    path.parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(follow_redirects=True, timeout=120, headers={"User-Agent": "dryrun-pipeline/0.1"}) as client:
        head = client.head(url)
        head.raise_for_status()
        length = int(head.headers["Content-Length"]) if "Content-Length" in head.headers else None
        offset = path.stat().st_size if path.exists() else 0
        if length is not None and offset == length:
            return str(path)
        if length is not None and offset > length:
            offset = 0
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        with client.stream("GET", url, headers=headers) as response:
            response.raise_for_status()
            resume = offset > 0 and response.status_code == 206
            if resume and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                raise ValueError("server returned an unexpected Content-Range")
            with path.open("ab" if resume else "wb") as stream:
                for chunk in response.iter_bytes():
                    stream.write(chunk)
        if length is not None and path.stat().st_size != length:
            raise ValueError("incomplete download; retry to resume")
    return str(path)


def download_vectors(out_dir: str) -> dict[str, str]:
    return {name: fetch_file(SOURCES[name]["url"], str(Path(out_dir) / filename))
            for name, filename in (("buildings", "103b_buildings.csv.gz"), ("osm", "nigeria-latest.osm.pbf"))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aoi-id", required=True)
    parser.add_argument("--bbox", nargs=4, type=float, required=True, metavar=("W", "S", "E", "N"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--vectors", action="store_true")
    args = parser.parse_args()
    report = download(args.aoi_id, tuple(args.bbox), args.out)
    if args.vectors:
        report["vectors"] = download_vectors(args.out)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
