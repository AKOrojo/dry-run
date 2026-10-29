"""Offline Sentinel-1 RTC change detection on the ee_export AOI grid."""

from __future__ import annotations

import argparse
import io
import json
import math
import warnings
from contextlib import nullcontext
from pathlib import Path
from urllib.parse import quote

import numpy as np

from dryrun import storage
from dryrun.contracts import GridSpec

# Assumptions: dark VV water and a substantial decrease indicate newly flooded ground.
WATER_DB = -18.0
CHANGE_DB = -3.0
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
SAS = "https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-1-rtc"
USER_AGENT = "dryrun-pipeline/0.1"
LICENCE = "CC BY 4.0 (Sentinel-1 RTC, Microsoft Planetary Computer)"
CREDIT = "Contains modified Copernicus Sentinel data 2026, processed by ESA; RTC by Microsoft Planetary Computer"


def _client():
    import httpx

    return httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=120, follow_redirects=True)


def _items(client, bbox, datetime_range):
    response = client.post(f"{STAC}/search", json={
        "collections": ["sentinel-1-rtc"], "bbox": list(bbox), "datetime": datetime_range,
    })
    items = []
    while True:
        response.raise_for_status()
        page = response.json()
        items.extend(page["features"])
        link = next((link for link in page.get("links", []) if link["rel"] == "next"), None)
        if link is None:
            return items
        method = link.get("method", "GET").upper()
        response = client.request(method, link["href"], **({"json": link.get("body", {})} if method == "POST" else {}))


def search(bbox, datetime_range) -> list[tuple]:
    """Return id, datetime, platform, relative orbit and orbit state for every match."""
    with _client() as client:
        return [(item["id"], *(item["properties"].get(key) for key in
                 ("datetime", "platform", "sat:relative_orbit", "sat:orbit_state")))
                for item in _items(client, bbox, datetime_range)]


def _orbit(item):
    props = item["properties"]
    orbit = (props.get("sat:relative_orbit"), props.get("sat:orbit_state"))
    if None in orbit:
        raise ValueError("scene lacks orbit metadata")
    return orbit


def _select(client, selector, bbox):
    # Datetime selectors must be exact; an id anchors the pass and its adjacent frames.
    if "T" in selector and selector[:4].isdigit():
        matches = [item for item in _items(client, bbox, selector)
                   if item["properties"]["datetime"] == selector]
        if not matches:
            raise ValueError(f"no scene at {selector}")
        anchor = matches[0]
    else:
        response = client.get(f"{STAC}/collections/sentinel-1-rtc/items/{quote(selector, safe='')}")
        response.raise_for_status()
        anchor = response.json()
    props = anchor["properties"]
    day = props["datetime"][:10]
    candidates = _items(client, bbox, f"{day}T00:00:00Z/{day}T23:59:59Z")
    scenes = {item["id"]: item for item in candidates
              if _orbit(item) == _orbit(anchor) and item["properties"].get("platform") == props.get("platform")}
    scenes[anchor["id"]] = anchor
    return [scenes[key] for key in sorted(scenes)]


def power_to_db(power):
    power = np.asarray(power, dtype=np.float32)
    out = np.full(power.shape, np.nan, np.float32)
    valid = np.isfinite(power) & (power > 0)
    out[valid] = 10 * np.log10(power[valid])
    return out


def speckle_filter(db):
    """Nodata-aware median; preserve missing center cells and clip at array edges."""
    db = np.asarray(db, dtype=np.float32)
    windows = np.lib.stride_tricks.sliding_window_view(np.pad(db, 1, constant_values=np.nan), (3, 3))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        out = np.nanmedian(windows, axis=(-2, -1))
    out[~np.isfinite(db)] = np.nan
    return out.astype(np.float32)


def flood_rule(pre, post):
    if pre.shape != post.shape:
        raise ValueError("scene shapes differ")
    valid = np.isfinite(pre) & np.isfinite(post)
    flooded = valid & (post < WATER_DB) & ((post - pre) < CHANGE_DB)
    return flooded.astype(np.float32), valid


def _resample(path, grid, transform):
    """Windowed COG read; average linear power before taking logarithms."""
    import rasterio
    from affine import Affine
    from rasterio.warp import Resampling, reproject, transform_bounds
    from rasterio.windows import Window, from_bounds

    out = np.full((grid.ny, grid.nx), np.nan, np.float32)
    remote = str(path).startswith(("https://", "http://"))
    local = nullcontext() if remote else rasterio.io.MemoryFile(storage.read_local_file(path))
    with rasterio.Env(GDAL_HTTP_USERAGENT=USER_AGENT, GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"), local as mem:
        with (rasterio.open("/vsicurl/" + str(path)) if remote else mem.open()) as src:
            bounds = transform_bounds(grid.crs, src.crs, *grid.bounds_wgs84)
            win = from_bounds(*bounds, transform=src.transform)
            left, top = max(0, math.floor(win.col_off)), max(0, math.floor(win.row_off))
            right = min(src.width, math.ceil(win.col_off + win.width))
            bottom = min(src.height, math.ceil(win.row_off + win.height))
            if right <= left or bottom <= top:
                return out
            win = Window(left, top, right - left, bottom - top)
            data = src.read(1, window=win, masked=True).astype(np.float32).filled(np.nan)
            data[~np.isfinite(data) | (data <= 0)] = np.nan
            reproject(data, out, src_transform=src.window_transform(win), src_crs=src.crs,
                      src_nodata=np.nan, dst_transform=Affine(*transform), dst_crs=grid.crs,
                      dst_nodata=np.nan, resampling=Resampling.average)
    return out


def _scene(items, token, grid, transform):
    result = {}
    for band in ("vv", "vh"):
        total = np.zeros((grid.ny, grid.nx), np.float64)
        count = np.zeros(total.shape, np.uint16)
        for item in items:
            href = item["assets"][band]["href"].split("?")[0]
            tile = _resample(href + "?" + token.lstrip("?"), grid, transform)
            valid = np.isfinite(tile)
            total[valid] += tile[valid]
            count[valid] += 1
        power = np.full(total.shape, np.nan, np.float32)
        np.divide(total, count, out=power, where=count > 0)
        result[band] = speckle_filter(power_to_db(power))
    return result


def _percentiles(array):
    values = array[np.isfinite(array)]
    return {str(p): float(np.percentile(values, p)) if values.size else None for p in (5, 25, 50, 75, 95)}


def export(grid_json_path, pre_item_id, post_item_id, out_dir,
           exclude_mask_path=None, boundary_mask_path=None) -> dict:
    import rasterio.io
    from affine import Affine

    metadata = json.loads(storage.read_local_file(grid_json_path))
    grid = GridSpec.model_validate({key: metadata[key] for key in GridSpec.model_fields if key in metadata})
    transform = tuple(metadata["transform"])
    with _client() as client:
        pre = _select(client, pre_item_id, grid.bounds_wgs84)
        post = _select(client, post_item_id, grid.bounds_wgs84)
        if _orbit(pre[0]) != _orbit(post[0]):
            raise ValueError("pre/post relative orbit and orbit state must match")
        response = client.get(SAS)
        response.raise_for_status()
        token = response.json()["token"]
        before = _scene(pre, token, grid, transform)
        after = _scene(post, token, grid, transform)
    flooded, valid = flood_rule(before["vv"], after["vv"])
    report = {"flooded_cells": int(flooded.sum()),
              "flooded_km2": float(flooded.sum() * grid.dx_m * grid.dy_m / 1e6),
              "valid_fraction": float(valid.mean()), "db_percentiles": {
                  f"{scene}_{band}": _percentiles(data[band])
                  for scene, data in (("pre", before), ("post", after)) for band in ("vv", "vh")}}
    for name, path in (("exclude", exclude_mask_path), ("boundary", boundary_mask_path)):
        if path is not None:
            mask = np.load(io.BytesIO(storage.read_local_file(path)), allow_pickle=False)
            if mask.shape != flooded.shape:
                raise ValueError(f"{name} mask shape differs from grid")
            report[f"flooded_cells_inside_{name}"] = int(((mask > 0.5) & (flooded > 0.5)).sum())
    folder = Path(out_dir)
    for name, array in {"obs_flood_extent": flooded, "pre_vv_db": before["vv"],
                        "post_vv_db": after["vv"], "valid": valid}.items():
        stream = io.BytesIO()
        np.save(stream, array, allow_pickle=False)
        storage.write_local_file(folder / f"{name}.npy", stream.getvalue())
        tif = array.astype(np.uint8) if array.dtype == bool else array
        with rasterio.io.MemoryFile() as mem:
            with mem.open(driver="GTiff", width=grid.nx, height=grid.ny, count=1, dtype=tif.dtype,
                          crs=grid.crs, transform=Affine(*transform), compress="deflate",
                          nodata=np.nan if name.endswith("_db") else None) as dst:
                dst.write(tif, 1)
            storage.write_local_file(folder / f"{name}.tif", mem.read())
    scenes = {name: [{"id": item["id"], "datetime": item["properties"]["datetime"],
                     "assets": {band: item["assets"][band]["href"].split("?")[0] for band in ("vv", "vh")}}
                    for item in items] for name, items in (("pre", pre), ("post", post))}
    meta = {"scenes": scenes, "relative_orbit": _orbit(pre[0])[0], "orbit_state": _orbit(pre[0])[1],
            "thresholds": {"water_db": WATER_DB, "change_db": CHANGE_DB}, "licence": LICENCE,
            "credit": CREDIT, "speckle_filter": "3x3 nodata-aware median in dB", "report": report,
            "grid": grid.model_dump(mode="json"), "transform": transform}
    storage.write_local_file(folder / "s1_meta.json", json.dumps(meta, indent=2, allow_nan=False).encode())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("grid", "pre", "post", "out", "exclude", "boundary", "dates"):
        parser.add_argument(f"--{flag}")
    parser.add_argument("--search", nargs=4, type=float, metavar=("W", "S", "E", "N"))
    args = parser.parse_args()
    if args.search:
        if not args.dates:
            parser.error("--search requires --dates")
        result = search(args.search, args.dates)
    else:
        if not all((args.grid, args.pre, args.post, args.out)):
            parser.error("export requires --grid, --pre, --post and --out")
        result = export(args.grid, args.pre, args.post, args.out, args.exclude, args.boundary)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
