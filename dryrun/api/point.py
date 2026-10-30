"""What is at one map point, with or without a run (waypoints): place, model ground, water, nearest building.

Distances are local metres (equirectangular about the point): fine at AOI scale. Building distances are to the
centre of the building's grid cell, so they are good to about one cell.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache

import numpy as np

from dryrun import storage
from dryrun.sim import exposure

_M_PER_DEG = 111_320.0


@lru_cache(maxsize=8)
def _places(aoi_id: str) -> list[tuple[str, list[list[tuple[float, float]]]]]:
    """(name, outer rings in degrees) per named place polygon; [] when the AOI has no places layer.
    Plain Python: shapely is a pipeline extra and not in the serving image."""
    if "places" not in storage.load_aoi(aoi_id).layers:
        return []
    gj = json.loads(storage.load_aoi_file(aoi_id, "places"))
    out = []
    for f in gj.get("features", []):
        name, geom = (f.get("properties") or {}).get("name"), f.get("geometry") or {}
        polys = [geom.get("coordinates", [])] if geom.get("type") == "Polygon" else geom.get("coordinates", []) \
            if geom.get("type") == "MultiPolygon" else []
        rings = [[(float(x), float(y)) for x, y, *_ in poly[0]] for poly in polys if poly and len(poly[0]) >= 3]
        if name and rings:
            out.append((str(name), rings))
    return out


def _inside(x: float, y: float, ring: list[tuple[float, float]]) -> bool:
    """Even-odd ray cast."""
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def _ring_distance_m(lon: float, lat: float, ring: list[tuple[float, float]]) -> float:
    kx = math.cos(math.radians(lat)) * _M_PER_DEG  # local metres per degree of longitude
    best = math.inf
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        ax, ay = (x1 - lon) * kx, (y1 - lat) * _M_PER_DEG
        bx, by = (x2 - lon) * kx, (y2 - lat) * _M_PER_DEG
        dx, dy = bx - ax, by - ay
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def _place(aoi_id: str, lon: float, lat: float) -> dict | None:
    places = _places(aoi_id)
    if not places:
        return None
    for name, rings in places:
        if any(_inside(lon, lat, r) for r in rings):
            return {"name": name, "inside": True, "distance_m": 0}
    name, d = min(((name, min(_ring_distance_m(lon, lat, r) for r in rings)) for name, rings in places), key=lambda t: t[1])
    return {"name": name, "inside": False, "distance_m": round(d)}


def _building(aoi_id: str, row: int, col: int, dx_m: float, dy_m: float) -> dict | None:
    if "buildings" not in storage.load_aoi(aoi_id).layers:
        return None
    ids, cells = exposure.building_cells(aoi_id)
    if not len(cells):
        return None
    d2 = ((cells[:, 0] - row) * dy_m) ** 2 + ((cells[:, 1] - col) * dx_m) ** 2
    i = int(np.argmin(d2))
    return {"id": ids[i], "cell": [int(cells[i, 0]), int(cells[i, 1])], "distance_m": round(math.sqrt(float(d2[i])))}


def describe(aoi_id: str, lon: float, lat: float) -> dict:
    """Raises ValueError outside the AOI grid."""
    m = storage.load_aoi(aoi_id)
    g = m.grid
    w, s, e, n = g.bounds_wgs84
    col, row = math.floor((lon - w) / (e - w) * g.nx), math.floor((n - lat) / (n - s) * g.ny)
    if not (0 <= row < g.ny and 0 <= col < g.nx):
        raise ValueError("point outside AOI")
    flag = lambda layer: bool(storage.load_raster(aoi_id, layer)[row, col] > 0.5) if layer in m.layers else None  # noqa: E731
    return {
        "aoi_id": aoi_id, "lon": lon, "lat": lat, "cell": [row, col],
        # The ground the flood model uses (the AOI DEM; EGM2008 heights for real AOIs), not the 3D map's terrain.
        "ground_m": round(float(storage.load_raster(aoi_id, "dem")[row, col]), 2),
        "open_water": flag("boundary_mask"),        # lagoon / sea
        "permanent_water": flag("exclude_mask"),    # any permanent water, canals included
        "place": _place(aoi_id, lon, lat),
        "building": _building(aoi_id, row, col, g.dx_m, g.dy_m),
        "is_synthetic": bool(m.is_synthetic),
    }
