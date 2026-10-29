"""Reported-flood hotspot validation, without reported-dry negative controls.

Hit rate alone rewards a model that floods everything; lift > 1 means flooding
concentrates where people reported it. Random discs provide a spatial null check.
"""
from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET

import numpy as np

from dryrun import storage

HIT_FRACTION = 0.10  # Assumption: a tenth of a reported location must flood to count as a hit.
RADIUS_M = 300
NULL_SAMPLES = 200
NULL_SEED = 7


class Geocoded(dict):
    """Name-indexed matches; unresolved names are kept separately."""

    def __init__(self):
        super().__init__()
        self.unmatched = []


def _normal(name):
    return re.sub(r"[\s-]+", "", name.casefold())


def _grid(grid):
    r, c = np.indices((grid.ny, grid.nx))
    w, s, e, n = grid.bounds_wgs84
    return w + (c + 0.5) * (e - w) / grid.nx, n - (r + 0.5) * (n - s) / grid.ny


def _ring(x, y, ring):
    inside = np.zeros(x.shape, bool)
    for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
        if ay != by:
            inside ^= ((ay > y) != (by > y)) & (x < (bx - ax) * (y - ay) / (by - ay) + ax)
    return inside


def _polygon(x, y, rings):
    mask = _ring(x, y, rings[0])
    for hole in rings[1:]:
        mask &= ~_ring(x, y, hole)
    return mask


def _osm(path):
    if path is None:
        return {}, []
    root = ET.fromstring(storage.read_local_file(path))
    nodes = {n.attrib['id']: (float(n.attrib['lon']), float(n.attrib['lat'])) for n in root.findall('node')}
    items = []
    for el in root:
        tags = {t.attrib['k']: t.attrib['v'] for t in el.findall('tag')}
        if 'name' not in tags:
            continue
        refs = [nd.attrib['ref'] for nd in el.findall('nd')]
        if el.tag == 'node':
            coords = [nodes[el.attrib['id']]]
        elif el.tag == 'way' and refs and all(ref in nodes for ref in refs):
            coords = [nodes[ref] for ref in refs]
        else:
            continue
        items.append((tags, el.tag, coords))
    return nodes, items


def _disc(grid, x, y, lon, lat):
    w, s, e, n = grid.bounds_wgs84
    return ((x - lon) * grid.nx * grid.dx_m / (e - w)) ** 2 + (
        (y - lat) * grid.ny * grid.dy_m / (n - s)) ** 2 <= RADIUS_M**2


def _road(grid, coords):
    mask = np.zeros((grid.ny, grid.nx), bool)
    w, s, e, n = grid.bounds_wgs84
    points = [((n - lat) * grid.ny / (n - s), (lon - w) * grid.nx / (e - w)) for lon, lat in coords]
    for a, b in zip(points, points[1:]):
        count = max(2, int(np.ceil(np.linalg.norm(np.subtract(b, a)) * 2)) + 1)
        samples = np.floor(np.linspace(a, b, count)).astype(int)
        r, c = samples.T
        valid = (r >= 0) & (r < grid.ny) & (c >= 0) & (c < grid.nx)
        mask[r[valid], c[valid]] = True
    padded = np.pad(mask, 1)
    return np.logical_or.reduce([padded[r:r + grid.ny, c:c + grid.nx] for r in range(3) for c in range(3)])


def geocode(hotspots, aoi_id, osm_features_xml=None, osm_roads_xml=None):
    """Resolve exact normalized names in layer order; union same-name OSM road segments."""
    aoi = storage.load_aoi(aoi_id)
    grid = aoi.grid
    x, y = _grid(grid)
    land = ~(storage.load_raster(aoi_id, 'exclude_mask') > 0.5)
    places = json.loads(storage.load_aoi_file(aoi_id, 'places'))['features'] if 'places' in aoi.layers else []
    _, features = _osm(osm_features_xml)
    _, roads = _osm(osm_roads_xml)
    result = Geocoded()
    for h in hotspots.get('hotspots', []) if isinstance(hotspots, dict) else hotspots:
        names = [h['name'], *h.get('osm_names', [])]
        mask, matched, how = None, None, None
        for name in names:
            found = [f for f in places if _normal(f['properties'].get('name', '')) == _normal(name)
                     and f['geometry']['type'] == 'Polygon']
            if found:
                mask = np.logical_or.reduce([_polygon(x, y, f['geometry']['coordinates']) for f in found])
                matched, how = found[0]['properties']['name'], 'places_polygon'
                break
        if mask is None:
            for name in names:
                candidates = roads if h['kind'] == 'road' else features
                masks = []
                for tags, kind, coords in candidates:
                    if _normal(tags['name']) != _normal(name):
                        continue
                    if h['kind'] == 'road' and kind == 'way':
                        masks.append(_road(grid, coords))
                        how = 'osm_road'
                    elif h['kind'] == 'place' and any(k in tags for k in ('place', 'amenity', 'landuse')):
                        if kind == 'node':
                            masks.append(_disc(grid, x, y, *coords[0]))
                            how = 'osm_node_disc'
                        elif len(coords) >= 4 and coords[0] == coords[-1]:
                            masks.append(_polygon(x, y, [coords]))
                            how = 'osm_way_polygon'
                    if masks:
                        matched = tags['name']
                if masks:
                    mask = np.logical_or.reduce(masks)
                    break
        if mask is None or not (mask & land).any():
            result.unmatched.append(h['name'])
            continue
        mask &= land
        result[h['name']] = dict(mask=mask, matched=matched, how=how, cells=int(mask.sum()), weak=h.get('weak', False))
    return result


def score(run_id, geocoded, threshold_m=0.15):
    """Report hit rates and concentration; no negative controls imply no specificity claim.

    Hit rate alone rewards flooding everything. Lift > 1 indicates concentration at
    reported locations. Null percentile uses 200 individual random land-centred discs
    (not means of resampled sets), with ties receiving half weight.
    """
    run = storage.load_run(run_id)
    aoi_id = run.scenario.aoi_id
    grid = storage.load_aoi(aoi_id).grid
    land = ~(storage.load_raster(aoi_id, 'exclude_mask') > 0.5)
    land &= ~(storage.load_raster(aoi_id, 'boundary_mask') > 0.5)
    wet = storage.load_depth(run_id, 'max_depth.npy') >= threshold_m
    rows = {}
    for name, entry in geocoded.items():
        mask = entry['mask']
        fraction = float(wet[mask].mean()) if mask.any() else None
        rows[name] = {k: v for k, v in entry.items() if k != 'mask'}
        rows[name].update(wet_fraction=fraction, hit=fraction >= HIT_FRACTION if fraction is not None else None)
    valid = [v for v in rows.values() if v['wet_fraction'] is not None]
    strong = [v for v in valid if not v.get('weak', False)]
    mean = float(np.mean([v['wet_fraction'] for v in valid])) if valid else None
    base = float(wet[land].mean()) if land.any() else None
    null = []
    if land.any():
        x, y = _grid(grid)
        indices = np.argwhere(land)
        rng = np.random.default_rng(NULL_SEED)
        for r, c in indices[rng.integers(len(indices), size=NULL_SAMPLES)]:
            mask = _disc(grid, x, y, x[r, c], y[r, c]) & land
            null.append(float(wet[mask].mean()))
    percentile = None
    if mean is not None and null:
        percentile = 100 * float(np.mean(np.array(null) < mean) + 0.5 * np.mean(np.array(null) == mean))
    return dict(run_id=run_id, aoi_id=aoi_id, threshold_m=threshold_m, hotspots=rows,
                unmatched=getattr(geocoded, 'unmatched', []), matched=len(valid),
                hit_rate=sum(v['hit'] for v in valid) / len(valid) if valid else None,
                weak_excluded_hit_rate=sum(v['hit'] for v in strong) / len(strong) if strong else None,
                mean_hotspot_wet_fraction=mean, base_rate=base, lift=mean / base if base and mean is not None else None,
                random_disc_percentile=percentile, null_samples=NULL_SAMPLES, null_seed=NULL_SEED)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('run_id')
    ap.add_argument('--hotspots', default='evals/validation/hotspots_lekki.json')
    ap.add_argument('--osm-features')
    ap.add_argument('--osm-roads')
    ap.add_argument('--threshold-m', type=float, default=0.15)
    args = ap.parse_args()
    hotspots = json.loads(storage.read_local_file(args.hotspots))
    aoi_id = storage.load_run(args.run_id).scenario.aoi_id
    coded = geocode(hotspots, aoi_id, args.osm_features, args.osm_roads)
    print(json.dumps(score(args.run_id, coded, args.threshold_m), indent=2))


if __name__ == '__main__':
    main()
