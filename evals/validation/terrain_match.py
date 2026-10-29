"""How well the solver's ground matches the terrain the 3D map draws (owner: Eng A).

The solver's DEM (Copernicus GLO-30, treated) is in EGM2008 heights; Cesium World Terrain is in WGS84
ellipsoid heights. This decodes the quantized-mesh tiles of Cesium World Terrain (ion asset 1) over an
AOI, converts the AOI DEM to ellipsoid heights (DEM + EGM2008 undulation N, from PROJ's network grid) and
compares the two at every mesh vertex inside the AOI. It answers: if the UI draws a 3D water surface at
ground + depth, how far off the visible terrain will it sit? (Draped frames need no heights.)

Needs pyproj (with PROJ network access for us_nga_egm08_25) and a Cesium ion token that can open asset 1.
  CESIUM_ION_TOKEN=... CESIUM_ORIGIN=http://localhost:5173 \\
  python evals/validation/terrain_match.py --aoi texas-guadalupe-v0 --level 13
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import struct
import urllib.request

import numpy as np

ION = "https://api.cesium.com/v1/assets/1/endpoint"
HEADER = 88  # center (3 f64), min/max height (2 f32), bounding sphere (4 f64), horizon point (3 f64)


def _get(url: str, headers: dict) -> bytes:
    body = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60).read()
    return gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body


def _unzigzag(a: np.ndarray) -> np.ndarray:
    a = a.astype(np.int32)
    return np.cumsum((a >> 1) ^ -(a & 1)).astype(np.float64)


def decode(tile: bytes, west: float, south: float, east: float, north: float) -> np.ndarray:
    """Quantized-mesh tile -> (n, 3) [lon, lat, ellipsoid height] of its vertices."""
    hmin, hmax = struct.unpack_from("<2f", tile, 24)
    n = struct.unpack_from("<I", tile, HEADER)[0]
    uvh = np.frombuffer(tile, "<u2", 3 * n, HEADER + 4).reshape(3, n)
    u, v, h = (_unzigzag(x) / 32767 for x in uvh)
    return np.column_stack([west + u * (east - west), south + v * (north - south), hmin + h * (hmax - hmin)])


def cesium_vertices(bounds, level: int, token: str, origin: str) -> np.ndarray:
    """All World Terrain vertices at `level` (geographic TMS: 2^(z+1) x 2^z tiles) over bounds."""
    ep = json.loads(_get(ION, {"Authorization": f"Bearer {token}", "Origin": origin, "Referer": origin + "/"}))
    hdr = {"Authorization": f"Bearer {ep['accessToken']}", "Accept": "application/vnd.quantized-mesh,*/*;q=0.01"}
    w, s, e, n = bounds
    size = 180.0 / 2 ** level
    out = []
    for x in range(int((w + 180) // size), int((e + 180) // size) + 1):
        for y in range(int((s + 90) // size), int((n + 90) // size) + 1):
            tw, ts = -180 + x * size, -90 + y * size
            tile = _get(f"{ep['url']}{level}/{x}/{y}.terrain?v=1.2.0", hdr)
            out.append(decode(tile, tw, ts, tw + size, ts + size))
    pts = np.concatenate(out)
    keep = (pts[:, 0] > w) & (pts[:, 0] < e) & (pts[:, 1] > s) & (pts[:, 1] < n)
    return pts[keep]


def egm2008_n(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Geoid undulation N (ellipsoid height of EGM2008 zero) at each point."""
    import pyproj

    pyproj.network.set_network_enabled(True)
    t = pyproj.Transformer.from_crs("EPSG:4326+3855", "EPSG:4979", always_xy=True)
    return np.asarray(t.transform(lon, lat, np.zeros_like(lon))[2])


def bilinear(grid: np.ndarray, bounds, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Sample a north-up cell-centred raster at lon/lat."""
    w, s, e, n = bounds
    ny, nx = grid.shape
    fx = np.clip((lon - w) / (e - w) * nx - 0.5, 0, nx - 1.001)
    fy = np.clip((n - lat) / (n - s) * ny - 0.5, 0, ny - 1.001)
    c, r = fx.astype(int), fy.astype(int)
    ax, ay = fx - c, fy - r
    return ((grid[r, c] * (1 - ax) + grid[r, c + 1] * ax) * (1 - ay)
            + (grid[r + 1, c] * (1 - ax) + grid[r + 1, c + 1] * ax) * ay)


def _summary(d: np.ndarray) -> dict:
    a = np.abs(d)
    return {"n": int(d.size), "median_m": round(float(np.median(d)), 2),
            "abs_p50_m": round(float(np.percentile(a, 50)), 2), "abs_p90_m": round(float(np.percentile(a, 90)), 2)}


def run(aoi_id: str, level: int, token: str, origin: str) -> dict:
    from dryrun import storage

    aoi = storage.load_aoi(aoi_id)
    bounds = aoi.grid.bounds_wgs84
    dem = storage.load_raster(aoi_id, "dem").astype(np.float64)
    pts = cesium_vertices(bounds, level, token, origin)
    lon, lat, h_cesium = pts.T
    n_geoid = egm2008_n(lon, lat)
    diff = bilinear(dem, bounds, lon, lat) + n_geoid - h_cesium  # + = our ground above the drawn terrain
    out = {"aoi_id": aoi_id, "level": level, "geoid_n_m": [round(float(n_geoid.min()), 2), round(float(n_geoid.max()), 2)],
           "all": _summary(diff)}
    try:  # inland AOIs: how the carved channel compares
        river = storage.load_raster(aoi_id, "exclude_mask") > 0.5
        w, s, e, n = bounds
        r = np.clip(((n - lat) / (n - s) * aoi.grid.ny).astype(int), 0, aoi.grid.ny - 1)
        c = np.clip(((lon - w) / (e - w) * aoi.grid.nx).astype(int), 0, aoi.grid.nx - 1)
        if river[r, c].any():
            out["permanent_water"] = _summary(diff[river[r, c]])
            out["land"] = _summary(diff[~river[r, c]])
    except FileNotFoundError:
        pass
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aoi", required=True)
    ap.add_argument("--level", type=int, default=13)
    a = ap.parse_args()
    print(json.dumps(run(a.aoi, a.level, os.environ["CESIUM_ION_TOKEN"],
                         os.getenv("CESIUM_ORIGIN", "http://localhost:5173")), indent=1))


if __name__ == "__main__":
    main()
