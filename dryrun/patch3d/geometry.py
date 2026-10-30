"""Patch geometry from the parent 2D run's AOI (owner: Eng A)."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from dryrun import storage

KX = 111320.0  # m per degree of longitude at the equator (times cos lat)
KY = 110540.0  # m per degree of latitude
VERTICAL_RATIO = 8  # dz = cell_m / VERTICAL_RATIO
HEADROOM_M = 1.5  # air above the highest water the 2D run reaches in the patch
BELOW_M = 0.5  # solid layers below the lowest ground, so every column has a floor


@dataclass
class Patch:
    lon0: float  # SW corner
    lat0: float
    size_m: float
    cell_m: float
    nx: int
    ny: int
    nz: int
    dz: float
    zmin: float
    ground: np.ndarray  # [ny, nx] m (EGM2008), row 0 = SOUTH (OpenFOAM y increases north)
    building: np.ndarray  # [ny, nx] int, index into building_ids, -1 = none
    top: np.ndarray  # [ny, nx] building top height (m), nan where no building
    building_ids: list[str]

    @property
    def kx(self) -> float:
        return KX * math.cos(math.radians(self.lat0 + self.size_m / 2 / KY))

    def lonlat(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return self.lon0 + x / self.kx, self.lat0 + y / KY

    @property
    def bounds_wgs84(self) -> tuple[float, float, float, float]:
        e, n = self.lonlat(np.array(self.size_m), np.array(self.size_m))
        return (self.lon0, self.lat0, float(e), float(n))

    def solid(self) -> np.ndarray:
        """[nz, ny, nx] True where the cell centre is below ground or inside a building."""
        zc = self.zmin + (np.arange(self.nz) + 0.5) * self.dz
        z = zc[:, None, None]
        inside = (self.building >= 0)[None] & (z < np.where(np.isnan(self.top), -np.inf, self.top)[None])
        return (z < self.ground[None]) | inside


def bilinear(grid_vals: np.ndarray, bounds, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Sample a north-up cell-centred AOI raster at lon/lat."""
    w, s, e, n = bounds
    ny, nx = grid_vals.shape
    fx = np.clip((lon - w) / (e - w) * nx - 0.5, 0, nx - 1.0001)
    fy = np.clip((n - lat) / (n - s) * ny - 0.5, 0, ny - 1.0001)
    c, r = fx.astype(int), fy.astype(int)
    ax, ay = fx - c, fy - r
    return ((grid_vals[r, c] * (1 - ax) + grid_vals[r, c + 1] * ax) * (1 - ay)
            + (grid_vals[r + 1, c] * (1 - ax) + grid_vals[r + 1, c + 1] * ax) * ay)


@lru_cache(maxsize=2)
def _footprints(aoi_id: str):
    gj = json.loads(storage.load_aoi_file(aoi_id, "buildings_geojson"))
    out = []
    for f in gj["features"]:
        g = f["geometry"]
        ring = g["coordinates"][0] if g["type"] == "Polygon" else g["coordinates"][0][0]
        a = np.asarray(ring, float)[:, :2]
        out.append((str(f["properties"]["id"]), float(f["properties"].get("height_m") or 0.0), a))
    return out


def _rasterise(ring: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Even-odd point-in-polygon at the cell centres (xs: [nx] lon, ys: [ny] lat)."""
    x, y = np.meshgrid(xs, ys)
    inside = np.zeros(x.shape, bool)
    pts = ring if (ring[0] == ring[-1]).all() else np.vstack([ring, ring[:1]])
    for (x1, y1), (x2, y2) in zip(pts[:-1], pts[1:]):
        crosses = (y1 > y) != (y2 > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
        inside ^= crosses & (x < xin)
    return inside


def build(aoi_id: str, center: tuple[float, float], size_m: float, cell_m: float, max_wse: float) -> Patch:
    aoi = storage.load_aoi(aoi_id)
    dem = storage.load_raster(aoi_id, "dem").astype(np.float64)
    lonc, latc = center
    kx = KX * math.cos(math.radians(latc))
    lon0, lat0 = lonc - size_m / 2 / kx, latc - size_m / 2 / KY
    n = int(round(size_m / cell_m))
    xs = lon0 + (np.arange(n) + 0.5) * cell_m / kx
    ys = lat0 + (np.arange(n) + 0.5) * cell_m / KY
    X, Y = np.meshgrid(xs, ys)
    w, s, e, nn = aoi.grid.bounds_wgs84
    if not (w <= lon0 and lon0 + size_m / kx <= e and s <= lat0 and lat0 + size_m / KY <= nn):
        raise ValueError("patch must lie inside the AOI")
    ground = bilinear(dem, aoi.grid.bounds_wgs84, X, Y)
    building = np.full((n, n), -1, int)
    top = np.full((n, n), np.nan)
    ids: list[str] = []
    for bid, h, ring in _footprints(aoi_id) if "buildings_geojson" in aoi.layers else []:
        if h <= 0 or ring[:, 0].max() < lon0 or ring[:, 0].min() > xs[-1] or ring[:, 1].max() < lat0 or ring[:, 1].min() > ys[-1]:
            continue
        m = _rasterise(ring, xs, ys)
        if not m.any():
            continue
        base = float(ground[m].max())  # the footprint sits on its highest ground cell
        building[m] = len(ids)
        top[m] = base + h
        ids.append(bid)
    dz = cell_m / VERTICAL_RATIO
    zmin = float(ground.min()) - BELOW_M
    zmax = max(float(max_wse), float(ground.max())) + HEADROOM_M
    nz = int(math.ceil((zmax - zmin) / dz))
    return Patch(lon0, lat0, size_m, cell_m, n, n, nz, dz, zmin, ground, building, top, ids)
