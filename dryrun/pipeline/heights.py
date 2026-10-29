"""Windowed Google Open Buildings 2.5D Temporal heights (Google, CC BY 4.0)."""

from __future__ import annotations

import argparse
import copy
import json
import math
from collections import defaultdict

import numpy as np

from dryrun import storage
from dryrun.pipeline.osm import DEFAULT_HEIGHT_M

MAX_WINDOW = 4096


def _band(src, word, fallback=None):
    for index, description in enumerate(src.descriptions, 1):
        if word in (description or "").casefold():
            return index
    if fallback is not None and 1 <= fallback <= src.count:
        return fallback
    raise ValueError(f"No {word} band; descriptions={src.descriptions!r}; explicit index={fallback!r}")


def footprint_heights(footprints, tile_urls, height_band=None, presence_min=None) -> dict:
    """Median positive pixels at polygon centres; combine samples across supplied tiles.

    Supply nonoverlapping tiles to avoid weighting overlap pixels twice. Presence filtering,
    when requested, uses the band whose description contains 'presence'. No manifest is read.
    """
    import rasterio
    from rasterio.crs import CRS
    from rasterio.features import geometry_mask
    from rasterio.warp import transform, transform_bounds
    from rasterio.windows import Window, from_bounds

    footprints = list(footprints)
    samples = defaultdict(list)
    wgs84 = CRS.from_epsg(4326)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_USERAGENT="dryrun-pipeline/0.1",
                      CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif", VSI_CACHE=True):
        for url in tile_urls:
            path = str(url)
            with rasterio.open("/vsicurl/" + path if path.startswith(("https://", "http://")) else path) as src:
                band = _band(src, "height", height_band)
                presence = _band(src, "presence") if presence_min is not None else None
                batches = defaultdict(list)
                for footprint in footprints:
                    ring = np.asarray(footprint["ring"], dtype=float)
                    bounds = transform_bounds(wgs84, src.crs, *ring.min(axis=0), *ring.max(axis=0))
                    win = from_bounds(*bounds, transform=src.transform)
                    left, top = max(0, math.floor(win.col_off)), max(0, math.floor(win.row_off))
                    right = min(src.width, math.ceil(win.col_off + win.width))
                    bottom = min(src.height, math.ceil(win.row_off + win.height))
                    if right <= left or bottom <= top:
                        continue
                    x, y = transform(wgs84, src.crs, ring[:, 0], ring[:, 1])
                    polygon = {"type": "Polygon", "coordinates": [list(zip(x, y))]}
                    for row in range(top // MAX_WINDOW, (bottom - 1) // MAX_WINDOW + 1):
                        for col in range(left // MAX_WINDOW, (right - 1) // MAX_WINDOW + 1):
                            rect = (max(left, col * MAX_WINDOW), max(top, row * MAX_WINDOW),
                                    min(right, (col + 1) * MAX_WINDOW), min(bottom, (row + 1) * MAX_WINDOW))
                            batches[row, col].append((footprint["id"], polygon, rect))
                for entries in batches.values():
                    left = min(e[2][0] for e in entries)
                    top = min(e[2][1] for e in entries)
                    right = max(e[2][2] for e in entries)
                    bottom = max(e[2][3] for e in entries)
                    win = Window(left, top, right - left, bottom - top)
                    data = src.read(band, window=win, masked=True)
                    valid = ~np.ma.getmaskarray(data) & np.isfinite(data.data) & (data.data > 0)
                    if presence is not None:
                        p = src.read(presence, window=win, masked=True)
                        valid &= ~np.ma.getmaskarray(p) & np.isfinite(p.data) & (p.data >= presence_min)
                    for ident, polygon, _ in entries:
                        inside = geometry_mask([polygon], out_shape=data.shape, transform=src.window_transform(win),
                                               invert=True)
                        values = data.data[valid & inside]
                        if values.size:
                            samples[ident].append(values)
    return {ident: float(np.median(np.concatenate(parts))) for ident, parts in samples.items()}


def apply_heights(buildings_geojson: dict, heights: dict, default=DEFAULT_HEIGHT_M, lo=2.5, hi=150.0):
    """Return a copy and coverage statistics; percentiles describe all output heights in metres."""
    if lo > hi:
        raise ValueError("lo must not exceed hi")
    result = copy.deepcopy(buildings_geojson)
    known, values = 0, []
    for feature in result["features"]:
        props = feature["properties"]
        height = heights.get(props.get("id", feature.get("id")))
        measured = height is not None and math.isfinite(height) and height > 0
        props["height_m"] = float(np.clip(round(height, 1), lo, hi)) if measured else default
        props["height_source"] = "2.5D" if measured else "assumed"
        known += int(measured)
        values.append(props["height_m"])
    total = len(values)
    report = {"total": total, "with_2_5d": known, "assumed": total - known,
              "share_2_5d": known / total if total else 0.0,
              "height_percentiles_m": {f"p{p}": float(np.percentile(values, p)) if values else None
                                       for p in (0, 25, 50, 75, 100)}}
    return result, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--buildings-geojson", required=True)
    parser.add_argument("--tiles", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--height-band", type=int)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if args.limit is not None and args.limit < 0:
        parser.error("--limit must be nonnegative")
    buildings = json.loads(storage.read_local_file(args.buildings_geojson))
    selected = buildings["features"][:args.limit]
    footprints = []
    for feature in selected:
        if feature["geometry"]["type"] != "Polygon":
            raise ValueError("Building geometry must be Polygon")
        footprints.append({"id": feature["properties"].get("id", feature.get("id")),
                           "ring": feature["geometry"]["coordinates"][0]})
    heights = footprint_heights(footprints, args.tiles, args.height_band) if footprints else {}
    result, report = apply_heights(buildings, heights)
    storage.write_local_file(args.out, storage.dumps(result))
    print(json.dumps(report, allow_nan=False))


if __name__ == "__main__":
    main()
