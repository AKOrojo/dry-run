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
"""


def download(aoi_id: str, bbox_wgs84: tuple[float, float, float, float], out_dir: str) -> None:
    raise NotImplementedError("Eng D Day 1")
