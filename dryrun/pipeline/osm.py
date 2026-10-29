"""Roads, buildings, shelters and named places for a real AOI (owner: Eng D).

roads.graphml  osmnx drive + walk, merged, then nx.Graph(ox.convert.to_undirected(G)) -> SIMPLE
               undirected graph written with nx.write_graphml (osmnx's save_graphml writes a
               MultiDiGraph, which exposure.road_graph rejects). Per edge: length_m, cells (JSON
               [[row,col],...] sampled every <= 1 cell), drive=1 if a drivable way (road_km counts
               drive edges only), bridge=1 for bridge=yes / tunnel (never cut by depth).
               Nodes: x=lon, y=lat, row, col.
buildings      Google Open Buildings v3 (confidence >= 0.8, area >= 25 m2; agree the cap with B Wed AM):
               buildings_index.json {"ids","row","col"} (serving path, no pandas) AND
               buildings_geojson (props id, height_m; 5-decimal coords; SAME ids; gzip it).
               Heights: Open Buildings 2.5D is Earth-Engine-only; without EE use 6 m for all (say so).
shelters       schools / places of worship / community centres on the higher half of land (SHELTER_TOP_FRACTION)
               AND within 300 m of a road node, labelled "candidate shelter (assumed)". Lagos is flat, so a fixed
               height cut is a weak test: routing.evac also skips a shelter whose own cell is flooded at the
               requested time. (The top-20% cut kept 6 of 30 in Lekki-Ajah and left most origins unroutable.)
places         up to MAX_PLACES named neighbourhoods/corridors/low areas: Polygon only (no MultiPolygon), simplified
               to <= 20 vertices, props name + kind (neighbourhood|corridor|low_area|open_land). The agent
               targets interventions and area stats by these names; match meta/media.LAGOS_KEYWORDS.
               Include a few `open_land` places so the agent has somewhere sensible to put ponds.

The rules are pure numpy/networkx functions (tested in CI, which has no osmnx/shapely). Only the
`_fetch_*` / `_read_*` helpers and build() touch the network, osmnx or shapely (`pip install -e .[pipeline]`).
Decisions taken here that the spec left open (also in the data card):
  - roads keep only the largest connected component, so an origin never snaps onto an island
    the router cannot leave;
  - parallel ways between the same two nodes collapse to the shortest; drive=1 if any of them is drivable;
  - over the building cap, the largest footprints are kept;
  - an OSM neighbourhood mapped only as a point becomes its Voronoi cell among the other named
    points, clipped to PLACE_RADIUS_M (an approximation, not a boundary).
"""

from __future__ import annotations

import hashlib
import io
import json
from collections.abc import Iterable, Sequence

import networkx as nx
import numpy as np

from dryrun.contracts import GridSpec

MIN_CONFIDENCE = 0.8
MIN_AREA_M2 = 25.0
BUILDING_CAP = 100_000         # UI budget; Lekki-Ajah has 68,929 after the filters (15 MB GeoJSON, under the
#                                25 MB gzip-to-bucket threshold), so all are kept. Over it the largest are kept.
DEFAULT_HEIGHT_M = 6.0         # no Earth Engine -> no 2.5D heights; the data card says so
SHELTER_TOP_FRACTION = 0.50    # static pre-filter; the real test is per run (evac skips flooded shelters)
SHELTER_MAX_SNAP_M = 300.0     # = routing.evac.MAX_SNAP_M
SHELTER_LABEL = "candidate shelter (assumed)"
MAX_PLACE_VERTICES = 20
MAX_PLACES = 20               # every name the agent sees is one it can resolve (get_aoi_info lists them)
MAX_CORRIDORS = 3
PLACE_RADIUS_M = 1500.0        # point-only neighbourhoods: Voronoi cell clipped to this radius
CORRIDOR_HALF_WIDTH_M = 150.0
OPEN_LAND_MIN_M2 = 20_000.0    # 2 ha: big enough for a retention pond
MAX_OPEN_LAND = 4

DRIVE_HIGHWAYS = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary",
    "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service",
}
SHELTER_TAGS = {"amenity": ["school", "place_of_worship", "community_centre"],
                "building": ["school", "church", "mosque"]}  # some are mapped only as a building
OPEN_LAND_TAGS = {"landuse": ["grass", "meadow", "greenfield", "brownfield", "recreation_ground"],
                  "leisure": ["park", "recreation_ground"], "natural": ["grassland", "scrub"]}

# OSM spelling -> LAGOS_KEYWORDS spelling, for names that differ (checked on the 2026-10-28 extract). Explicit, not
# fuzzy: a wrong match would put an intervention in the wrong neighbourhood.
PLACE_ALIASES = {"Lekki Phase I": "Lekki Phase 1", "Osapa London": "Osapa"}
# Never offered as open land (the agent puts ponds there): protected or sensitive sites, whatever their tags say.
# Lekki Conservation Centre is a mangrove reserve tagged only leisure=park.
NOT_OPEN_LAND = ("conservation", "reserve", "sanctuary", "cemetery", "golf", "school")

M_PER_DEG_LAT = 110_574.0


def _m_per_deg_lon(lat: float) -> float:
    return 111_320.0 * np.cos(np.radians(lat))


# ------------------------------------------------------------------------------------------- grid
def lonlat_to_rc(grid: GridSpec, lon, lat) -> tuple[np.ndarray, np.ndarray]:
    """Fractional (row, col); cell (r, c) spans [r, r+1) x [c, c+1)."""
    w, s, e, n = grid.bounds_wgs84
    return (n - np.asarray(lat, float)) / (n - s) * grid.ny, (np.asarray(lon, float) - w) / (e - w) * grid.nx


def in_grid(grid: GridSpec, lon, lat) -> np.ndarray:
    r, c = lonlat_to_rc(grid, lon, lat)
    return (r >= 0) & (r < grid.ny) & (c >= 0) & (c < grid.nx)


def cell_of(grid: GridSpec, lon, lat) -> tuple[np.ndarray, np.ndarray]:
    """Integer cell, clipped to the grid."""
    r, c = lonlat_to_rc(grid, lon, lat)
    return (np.clip(np.floor(r), 0, grid.ny - 1).astype(int), np.clip(np.floor(c), 0, grid.nx - 1).astype(int))


def line_cells(grid: GridSpec, coords: Sequence[tuple[float, float]]) -> list[list[int]]:
    """Cells along a lon/lat polyline, sampled every <= 0.5 cell (so no crossed cell is skipped by more
    than a corner), consecutive duplicates dropped. Samples outside the grid are dropped (clamping them would
    invent cells along the border). >= 2 entries, since exposure.edge_arrays needs both endpoint cells and a
    line inside one cell repeats it; [] if the line never enters the grid."""
    xy = np.asarray(coords, float).reshape(-1, 2)
    r, c = lonlat_to_rc(grid, xy[:, 0], xy[:, 1])
    pts = [np.array([[r[0], c[0]]])]
    for i in range(1, len(xy)):
        n = max(1, int(np.ceil(2 * max(abs(r[i] - r[i - 1]), abs(c[i] - c[i - 1])))))
        t = np.arange(1, n + 1)[:, None] / n
        pts.append(np.hstack([r[i - 1] + t * (r[i] - r[i - 1]), c[i - 1] + t * (c[i] - c[i - 1])]))
    p = np.floor(np.vstack(pts))
    p = p[(p[:, 0] >= 0) & (p[:, 0] < grid.ny) & (p[:, 1] >= 0) & (p[:, 1] < grid.nx)]
    if not len(p):
        return []
    rc = p.astype(int)
    keep = np.ones(len(rc), bool)
    keep[1:] = np.any(rc[1:] != rc[:-1], axis=1)
    out = rc[keep].tolist()
    return out if len(out) >= 2 else out * 2


# ------------------------------------------------------------------------------------------ roads
def _flag(v) -> bool:
    """OSM tag value(s) -> truthy (osmnx merges tags of simplified ways into lists)."""
    vals = v if isinstance(v, list | tuple | set) else [v]
    return any(x not in (None, "", "no", "0", False) and x == x for x in vals)  # x == x drops NaN


def is_drive(highway) -> bool:
    vals = highway if isinstance(highway, list | tuple | set) else [highway]
    return any(h in DRIVE_HIGHWAYS for h in vals)


def simple_road_graph(grid: GridSpec, nodes: dict, edges: Iterable[dict]) -> nx.Graph:
    """nodes {id: (lon, lat)}; edges [{u, v, length_m, coords (lon/lat polyline u->v, optional),
    drive, bridge}] -> the roads_graph contract. Self-loops dropped, parallel edges collapsed to the
    shortest (drive / bridge if any of them is), edges that never enter the grid dropped, only the largest
    connected component kept."""
    best: dict[tuple, dict] = {}
    for e in edges:
        u, v = e["u"], e["v"]
        if u == v or u not in nodes or v not in nodes:
            continue
        key = (u, v) if str(u) <= str(v) else (v, u)
        old = best.get(key)
        if old is None or e["length_m"] < old["length_m"]:
            best[key] = {**e, "drive": bool(e["drive"]) or bool(old and old["drive"]),
                         "bridge": bool(e["bridge"]) or bool(old and old["bridge"])}
        else:
            old["drive"] = old["drive"] or bool(e["drive"])
            old["bridge"] = old["bridge"] or bool(e["bridge"])
    g = nx.Graph()
    for (u, v), e in best.items():
        cells = line_cells(grid, e.get("coords") or [nodes[e["u"]], nodes[e["v"]]])
        if not cells:
            continue
        for n in (u, v):
            lon, lat = nodes[n]
            r, c = cell_of(grid, lon, lat)
            g.add_node(str(n), x=float(lon), y=float(lat), row=int(r), col=int(c))
        g.add_edge(str(u), str(v), length_m=float(e["length_m"]), drive=int(bool(e["drive"])),
                   bridge=int(bool(e["bridge"])), cells=json.dumps(cells))
    if g.number_of_nodes():
        g = g.subgraph(max(nx.connected_components(g), key=len)).copy()
    return g


def graphml_bytes(g: nx.Graph) -> bytes:
    buf = io.BytesIO()
    nx.write_graphml(g, buf)
    return buf.getvalue()


# -------------------------------------------------------------------------------------- buildings
def buildings_layers(grid: GridSpec, records: Iterable[dict], cap: int = BUILDING_CAP) -> tuple[dict, dict]:
    """records [{id, lon, lat, area_m2, confidence, ring [(lon, lat), ...]}] (Open Buildings v3 rows)
    -> (buildings_index, buildings_geojson) with the SAME ids in the same order."""
    keep = [b for b in records if (b["confidence"] == -1 or b["confidence"] >= MIN_CONFIDENCE)
            and b["area_m2"] >= MIN_AREA_M2
            and bool(in_grid(grid, b["lon"], b["lat"]))]
    if len(keep) > cap:
        keep = sorted(keep, key=lambda b: -b["area_m2"])[:cap]
    keep.sort(key=lambda b: str(b["id"]))
    seen: dict[str, int] = {}
    for b in keep:  # plus codes name ~3 m cells, so two footprints can share one: suffix repeats
        k = str(b["id"])
        seen[k] = seen.get(k, 0) + 1
        b["id"] = k if seen[k] == 1 else f"{k}-{seen[k]}"
    rows, cols = cell_of(grid, [b["lon"] for b in keep], [b["lat"] for b in keep]) if keep else ([], [])
    index = {"ids": [str(b["id"]) for b in keep], "row": [int(r) for r in rows], "col": [int(c) for c in cols]}
    feats = [{"type": "Feature", "properties": {"id": str(b["id"]), "height_m": b.get("height_m", DEFAULT_HEIGHT_M)},
              "geometry": {"type": "Polygon",
                           "coordinates": [[[round(x, 5), round(y, 5)] for x, y in b["ring"]]]}} for b in keep]
    return index, {"type": "FeatureCollection", "features": feats}


# --------------------------------------------------------------------------------------- shelters
def pick_shelters(grid: GridSpec, candidates: Iterable[dict], dem: np.ndarray, land: np.ndarray,
                  road: nx.Graph) -> dict:
    """candidates [{name, kind, lon, lat}] -> shelters GeoJSON: inside the grid, on a land cell in the
    top SHELTER_TOP_FRACTION of land DEM, and within SHELTER_MAX_SNAP_M of a road node."""
    land = np.asarray(land, bool) & np.isfinite(dem)
    if not road.number_of_nodes() or not land.any():
        return {"type": "FeatureCollection", "features": []}
    cut = float(np.quantile(dem[land], 1 - SHELTER_TOP_FRACTION))
    xy = np.array([[d["x"], d["y"]] for _, d in road.nodes(data=True)], float)
    feats, seen = [], set()
    for s in candidates:
        lon, lat = float(s["lon"]), float(s["lat"])
        if not in_grid(grid, lon, lat):
            continue
        r, c = (int(v) for v in cell_of(grid, lon, lat))
        if not land[r, c] or dem[r, c] < cut or (r, c) in seen:
            continue
        snap = np.hypot((xy[:, 0] - lon) * _m_per_deg_lon(lat), (xy[:, 1] - lat) * M_PER_DEG_LAT).min()
        if snap > SHELTER_MAX_SNAP_M:
            continue
        seen.add((r, c))
        name = s.get("name") or f"Unnamed {s['kind'].replace('_', ' ')}"
        feats.append({"type": "Feature",
                      "properties": {"name": f"{name} ({SHELTER_LABEL})", "kind": s["kind"], "row": r, "col": c,
                                     "status": SHELTER_LABEL},
                      "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]}})
    return {"type": "FeatureCollection", "features": feats}


# ----------------------------------------------------------------------------------------- places
def simplify_ring(ring: Sequence[tuple[float, float]], max_vertices: int = MAX_PLACE_VERTICES) -> list[list[float]]:
    """Visvalingam-Whyatt: drop the vertex with the smallest triangle area until <= max_vertices
    distinct vertices remain. Returns a closed ring."""
    pts = [list(map(float, p)) for p in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    while len(pts) > max(3, max_vertices):
        a = np.array(pts)
        prv, nxt = np.roll(a, 1, 0), np.roll(a, -1, 0)
        area = np.abs((prv[:, 0] - a[:, 0]) * (nxt[:, 1] - a[:, 1]) - (nxt[:, 0] - a[:, 0]) * (prv[:, 1] - a[:, 1]))
        pts.pop(int(np.argmin(area)))
    return [[round(x, 6), round(y, 6)] for x, y in pts + pts[:1]]


def convex_hull(points: np.ndarray) -> list[list[float]]:
    """Monotone chain hull of (lon, lat) points, closed ring."""
    p = sorted(set(map(tuple, np.asarray(points, float).tolist())))
    if len(p) < 3:
        return [list(q) for q in p + p[:1]]

    def half(seq):
        h = []
        for q in seq:
            while len(h) >= 2 and ((h[-1][0] - h[-2][0]) * (q[1] - h[-2][1])
                                   - (h[-1][1] - h[-2][1]) * (q[0] - h[-2][0])) <= 0:
                h.pop()
            h.append(q)
        return h[:-1]

    hull = half(p) + half(p[::-1])
    return [list(q) for q in hull + hull[:1]]


def point_places(grid: GridSpec, points: dict[str, tuple[float, float]],
                 radius_m: float = PLACE_RADIUS_M) -> dict[str, list[list[float]]]:
    """Named points -> {name: ring}: each point's Voronoi cell among the others, clipped to radius_m and
    to the grid (convex, so the hull of its cell centres is the region)."""
    if not points:
        return {}
    w, s, e, n = grid.bounds_wgs84
    rr, cc = np.mgrid[0:grid.ny, 0:grid.nx]
    lon = w + (cc + 0.5) * (e - w) / grid.nx
    lat = n - (rr + 0.5) * (n - s) / grid.ny
    kx, ky = _m_per_deg_lon((n + s) / 2), M_PER_DEG_LAT
    names = list(points)
    d = np.stack([np.hypot((lon - points[k][0]) * kx, (lat - points[k][1]) * ky) for k in names])
    owner, near = d.argmin(0), d.min(0) <= radius_m
    out = {}
    for i, k in enumerate(names):
        m = (owner == i) & near
        if m.sum() >= 3:
            out[k] = convex_hull(np.column_stack([lon[m], lat[m]]))
    return out


def match_keyword(name: str | None, keywords: Sequence[str], place_aliases: dict | None = None) -> str | None:
    """OSM name -> the canonical keyword spelling, or None. Case/space/hyphen-insensitive."""
    if not isinstance(name, str) or not name:  # pandas gives NaN for features with no name
        return None

    def norm(x):
        return " ".join(x.casefold().replace("-", " ").split())

    by = {norm(k): k for k in keywords}
    by.update({norm(a): k for a, k in {**PLACE_ALIASES, **(place_aliases or {})}.items() if k in keywords})
    return by.get(norm(name))


def usable_open_land(name, leisure=None, boundary=None) -> bool:
    """False for nature reserves / protected areas, and for names in NOT_OPEN_LAND."""
    if leisure == "nature_reserve" or boundary == "protected_area":
        return False
    return not (isinstance(name, str) and any(w in name.casefold() for w in NOT_OPEN_LAND))


def places_collection(candidates: Iterable[dict], max_places: int = MAX_PLACES) -> dict:
    """[{name, kind, ring}] in priority order -> places GeoJSON: first of each name wins, rings simplified
    to <= MAX_PLACE_VERTICES, at most max_places."""
    feats, seen = [], set()
    for p in candidates:
        if p["name"] in seen or len(p["ring"]) < 4:
            continue
        seen.add(p["name"])
        feats.append({"type": "Feature", "properties": {"name": p["name"], "kind": p["kind"]},
                      "geometry": {"type": "Polygon", "coordinates": [simplify_ring(p["ring"])]}})
        if len(feats) >= max_places:
            break
    return {"type": "FeatureCollection", "features": feats}


def empty_layers() -> dict[str, bytes]:
    """The -v0 placeholders: a VALID empty simple graph and empty shelters/places, so every simulate works."""
    fc = json.dumps({"type": "FeatureCollection", "features": []}).encode()
    return {"roads.graphml": graphml_bytes(nx.Graph()), "shelters.geojson": fc, "places.geojson": fc}


# ------------------------------------------------------------------- I/O (offline, [pipeline] extra)
def _bbox(grid: GridSpec) -> tuple[float, float, float, float]:
    return tuple(grid.bounds_wgs84)  # (west, south, east, north) = osmnx 2.x bbox order


def osm_extract(pbf: str, grid: GridSpec, out_dir: str) -> dict[str, str]:
    """Geofabrik country .pbf -> AOI-clipped OSM XML that osmnx reads offline (needs the `osmium` CLI).
    The primary path: public Overpass servers were down or at capacity when tested (2026-10-29), and a
    dated extract makes the AOI reproducible. Returns {"roads": path, "features": path}."""
    import subprocess
    from pathlib import Path

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    w, s, e, n = grid.bounds_wgs84
    aoi, roads, feats = out / "aoi.osm.pbf", out / "roads.osm", out / "features.osm"
    run = lambda *a: subprocess.run(["osmium", *a, "--overwrite"], check=True)  # noqa: E731
    run("extract", "-b", f"{w},{s},{e},{n}", "--strategy", "complete_ways", str(pbf), "-o", str(aoi))
    run("tags-filter", str(aoi), "w/highway", "-o", str(roads))
    run("tags-filter", str(aoi), "nwr/amenity", "nwr/place", "nwr/landuse", "nwr/leisure", "nwr/natural", "w/waterway",
        "w/highway", "-o", str(feats))
    return {"roads": str(roads), "features": str(feats)}


# Ways osmnx's "all" network would still keep but nobody can route along.
NON_ROUTABLE = {"proposed", "construction", "abandoned", "platform", "raceway", "bus_stop", "elevator", "corridor"}


def _fetch_roads(grid: GridSpec, roads_xml: str | None = None) -> nx.Graph:
    """From an osm_extract() file when given (drive flag from the highway tag), else Overpass drive + walk."""
    ox = _ox()

    if roads_xml:
        G = ox.graph_from_xml(roads_xml, bidirectional=True, simplify=True, retain_all=True)
        G = ox.truncate.truncate_graph_bbox(G, _bbox(grid), truncate_by_edge=True)
        nets = [(None, G)]
    else:
        nets = [(net, ox.graph_from_bbox(_bbox(grid), network_type=net, simplify=True, truncate_by_edge=True,
                                         retain_all=True)) for net in ("drive", "walk")]
    edges, nodes = [], {}
    for net, G in nets:
        for n, d in G.nodes(data=True):
            nodes[n] = (d["x"], d["y"])
        for u, v, d in ox.convert.to_undirected(G).edges(data=True):
            hw = d.get("highway")
            if not set(hw if isinstance(hw, list) else [hw]) - NON_ROUTABLE:
                continue
            geom = d.get("geometry")
            coords = list(geom.coords) if geom is not None else None
            if coords and coords[0] != nodes[u] and coords[-1] == nodes[u]:
                coords = coords[::-1]
            edges.append({"u": u, "v": v, "length_m": float(d["length"]), "coords": coords,
                          # Overpass: only the drive graph's edges (the walk graph splits the same streets
                          # differently, so its copies would double count road_km); file: from the tag.
                          "drive": net == "drive" if net else is_drive(hw),
                          "bridge": _flag(d.get("bridge")) or _flag(d.get("tunnel"))})
    return simple_road_graph(grid, nodes, edges)


def _features(grid: GridSpec, tags: dict, features_xml: str | None):
    """OSM features in the AOI: from an osm_extract() file when given, else Overpass."""
    ox = _ox()
    if features_xml:
        from shapely.geometry import box

        return ox.features_from_xml(features_xml, polygon=box(*_bbox(grid)), tags=tags)
    return ox.features_from_bbox(_bbox(grid), tags)


def _ox():
    """osmnx with a polite User-Agent and a configurable Overpass mirror: overpass-api.de answers 406
    to default clients and is often at capacity (checked 2026-10-29)."""
    import os

    import osmnx as ox

    ox.settings.http_user_agent = "dryrun-pipeline/0.1 (+https://github.com/AKOrojo/dry-run)"
    ox.settings.overpass_url = os.getenv("DRYRUN_OVERPASS_URL", "https://maps.mail.ru/osm/tools/overpass/api")
    ox.settings.requests_timeout = 300
    return ox


def _read_open_buildings(grid: GridSpec, paths: Sequence[str]) -> Iterable[dict]:
    """Stream Open Buildings v3 CSV(.gz) tiles, columns latitude, longitude, area_in_meters, confidence,
    geometry (WKT), full_plus_code. The level-6 `_no_header` files (103b covers Lekki-Ajah) have no header
    row, the level-4 files do; a header row is skipped. The cheap lat/lon/score filter runs before WKT parsing."""
    import csv
    import gzip

    from shapely import wkt

    csv.field_size_limit(1 << 24)
    for path in paths:
        with (gzip.open(path, "rt") if str(path).endswith(".gz") else open(path)) as f:
            for row in csv.reader(f):
                if row[0] == "latitude":
                    continue
                lat, lon, area, conf = (float(v) for v in row[:4])
                if conf < MIN_CONFIDENCE or area < MIN_AREA_M2 or not in_grid(grid, lon, lat):
                    continue
                geom = wkt.loads(row[4])
                if geom.geom_type == "MultiPolygon":
                    geom = max(geom.geoms, key=lambda g: g.area)
                yield {"id": row[5], "lon": lon, "lat": lat, "area_m2": area,
                       "confidence": conf, "ring": list(geom.exterior.coords)}


def _read_ms_buildings(grid: GridSpec, paths: Sequence[str]) -> Iterable[dict]:
    """Read Microsoft newline GeoJSON, retaining the largest exterior of each footprint."""
    import gzip

    from dryrun import storage

    for path in paths:
        data = storage.read_local_file(path)
        for line in gzip.GzipFile(fileobj=io.BytesIO(data)):
            if not line.strip():
                continue
            feature = json.loads(line)
            geom, props = feature["geometry"], feature.get("properties", {})
            polygons = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
            parts = []
            for polygon in polygons:
                ring = np.asarray(polygon[0], float)
                # Shift before shoelace to avoid cancellation at large longitude/latitude.
                origin = ring[0]
                xy = ring - origin
                cross = xy[:, 0] * np.roll(xy[:, 1], -1) - np.roll(xy[:, 0], -1) * xy[:, 1]
                twice_area = cross.sum()
                if twice_area == 0:
                    continue
                centroid = ((xy + np.roll(xy, -1, axis=0)) * cross[:, None]).sum(0) / (3 * twice_area)
                lon, lat = centroid + origin
                area = abs(twice_area) / 2 * _m_per_deg_lon(lat) * M_PER_DEG_LAT
                parts.append((area, float(lon), float(lat), ring.tolist()))
            if not parts:
                continue
            area, lon, lat, ring = max(parts, key=lambda p: p[0])
            confidence = props.get("confidence", -1)
            if (confidence != -1 and confidence < MIN_CONFIDENCE) or area < MIN_AREA_M2 or not in_grid(grid, lon, lat):
                continue
            key = hashlib.sha1(f"{lon:.6f},{lat:.6f}".encode()).hexdigest()[:12]
            record = {"id": "ms-" + key, "lon": lon, "lat": lat, "area_m2": area,
                      "confidence": confidence, "ring": ring}
            if props.get("height", -1) > 0:
                record["height_m"] = props["height"]
            yield record


def building_reader(source: str):
    if source not in {"open_buildings", "ms"}:
        raise ValueError(f"unknown building source: {source}")
    return _read_ms_buildings if source == "ms" else _read_open_buildings


def _fetch_shelter_candidates(grid: GridSpec, features_xml: str | None = None) -> list[dict]:
    gdf = _features(grid, SHELTER_TAGS, features_xml)
    out = []
    for _, f in gdf.iterrows():
        pt = f.geometry.representative_point()
        name = f.get("name")
        kind = f.get("amenity") if isinstance(f.get("amenity"), str) else {"church": "place_of_worship",
                "mosque": "place_of_worship"}.get(f.get("building"), f.get("building"))
        out.append({"name": name if isinstance(name, str) else None, "kind": kind,
                    "lon": pt.x, "lat": pt.y})
    return out


def _fetch_place_candidates(grid: GridSpec, keywords: Sequence[str], features_xml: str | None = None,
                            place_aliases: dict | None = None) -> list[dict]:
    """Neighbourhoods (polygons first, then Voronoi cells of named points), corridors (named roads
    buffered), then the largest open land. Priority order = output order."""
    from shapely.geometry import Point, box
    from shapely.ops import unary_union

    aoi = box(*_bbox(grid))
    lat0 = (grid.bounds_wgs84[1] + grid.bounds_wgs84[3]) / 2
    deg = 1 / M_PER_DEG_LAT  # buffers in degrees of latitude; fine at 6 N for a few hundred metres
    polys, pts, corridors, open_land = [], {}, [], []

    def ring(geom):
        if geom.geom_type == "MultiPolygon":
            geom = max(geom.geoms, key=lambda g: g.area)
        return list(geom.exterior.coords) if geom.geom_type == "Polygon" else []

    hoods = _features(grid, {"place": ["suburb", "neighbourhood", "quarter", "village", "town"]}, features_xml)
    for _, f in hoods.iterrows():
        k = match_keyword(f.get("name"), keywords, place_aliases)
        if not k:
            continue
        g = f.geometry.intersection(aoi)
        if g.geom_type in ("Polygon", "MultiPolygon") and not g.is_empty:
            polys.append({"name": k, "kind": "neighbourhood", "ring": ring(g)})
        elif isinstance(f.geometry, Point) and aoi.contains(f.geometry):
            pts.setdefault(k, (f.geometry.x, f.geometry.y))
    have = {p["name"] for p in polys}
    for k, r in point_places(grid, {k: v for k, v in pts.items() if k not in have}).items():
        polys.append({"name": k, "kind": "neighbourhood", "ring": r})

    roads = _features(grid, {"highway": True}, features_xml)
    by_name: dict[str, list] = {}
    for _, f in roads.iterrows():
        k = match_keyword(f.get("name"), keywords, place_aliases)
        if k and f.geometry.geom_type in ("LineString", "MultiLineString"):
            by_name.setdefault(k, []).append(f.geometry)
    for k, lines in by_name.items():
        g = unary_union(lines).buffer(CORRIDOR_HALF_WIDTH_M * deg).intersection(aoi)
        if not g.is_empty:
            corridors.append({"name": k, "kind": "corridor", "ring": ring(g), "area": g.area})

    land = _features(grid, OPEN_LAND_TAGS, features_xml)
    m2 = M_PER_DEG_LAT * _m_per_deg_lon(lat0)
    cands = []
    for _, f in land.iterrows():
        name = f.get("name")
        if not usable_open_land(name, f.get("leisure"), f.get("boundary")):
            continue
        g = f.geometry.intersection(aoi)
        if g.geom_type in ("Polygon", "MultiPolygon") and g.area * m2 >= OPEN_LAND_MIN_M2:
            cands.append((g.area, name, g))
    hood_xy = {p["name"]: np.mean(np.array(p["ring"], float), axis=0) for p in polys}
    taken: dict[str, int] = {}
    for _, name, g in sorted(cands, key=lambda t: -t[0])[:MAX_OPEN_LAND]:
        if isinstance(name, str):
            label = f"{name} (open land)"
        else:  # unnamed: "Open land near <nearest neighbourhood>", numbered if that repeats
            c = g.centroid
            near = min(hood_xy, key=lambda k: np.hypot(*(hood_xy[k] - (c.x, c.y)))) if hood_xy else "AOI"
            taken[near] = taken.get(near, 0) + 1
            label = f"Open land near {near}" + (f" {taken[near]}" if taken[near] > 1 else "")
        open_land.append({"name": label, "kind": "open_land", "ring": ring(g)})

    # Corridors and open land get reserved slots (the agent needs the expressway and somewhere for ponds);
    # neighbourhoods fill the rest.
    corridors.sort(key=lambda p: -p.pop("area"))  # the longest roads first
    corridors = corridors[:MAX_CORRIDORS]
    return polys[: MAX_PLACES - len(corridors) - len(open_land)] + corridors + open_land


def build(aoi_id: str, grid: GridSpec, dem: np.ndarray, exclude: np.ndarray,
          building_csvs: Sequence[str], osm_files: dict[str, str] | None = None,
          building_source: str = "open_buildings", keywords: Sequence[str] | None = None,
          place_aliases: dict | None = None
          ) -> tuple[dict[str, str], dict[str, str], dict]:
    """Read OSM (osm_extract() files, or Overpass when osm_files is None) + Open Buildings, write the vector
    layers for `aoi_id` through storage. Returns (layers, sources, report) for the manifest that
    build_layers.build() writes."""
    roads_xml, feats_xml = (osm_files or {}).get("roads"), (osm_files or {}).get("features")
    from dryrun import storage
    from dryrun.meta.media import LAGOS_KEYWORDS

    keywords = LAGOS_KEYWORDS if keywords is None else keywords
    reader = building_reader(building_source)
    w = storage.write_aoi_file
    road = _fetch_roads(grid, roads_xml)
    w(aoi_id, "roads.graphml", graphml_bytes(road), "application/xml")

    index, geo = buildings_layers(grid, reader(grid, building_csvs))
    w(aoi_id, "buildings_index.json", json.dumps(index).encode(), "application/json")
    w(aoi_id, "buildings.geojson", json.dumps(geo, separators=(",", ":")).encode(), "application/geo+json")

    shelters = pick_shelters(grid, _fetch_shelter_candidates(grid, feats_xml), dem, ~np.asarray(exclude, bool), road)
    w(aoi_id, "shelters.geojson", json.dumps(shelters).encode(), "application/geo+json")

    places = places_collection(_fetch_place_candidates(grid, keywords, feats_xml, place_aliases))
    w(aoi_id, "places.geojson", json.dumps(places).encode(), "application/geo+json")

    osm = "© OpenStreetMap contributors, ODbL 1.0"
    layers = {"roads_graph": "roads.graphml", "buildings": "buildings_index.json",
              "buildings_geojson": "buildings.geojson", "shelters": "shelters.geojson", "places": "places.geojson"}
    ob = f"Google Open Buildings v3, CC BY 4.0 (heights: {DEFAULT_HEIGHT_M:g} m assumed for all; no 2.5D data)"
    if building_source == "ms":
        ob = "Microsoft Global ML Building Footprints, ODbL"
    sources = {"roads_graph": osm, "buildings": ob, "buildings_geojson": ob,
               "shelters": f"{osm}; {SHELTER_LABEL}", "places": f"{osm}; derived polygons (see osm.py)"}
    found = {f["properties"]["name"] for f in places["features"]}
    report = {"road_nodes": road.number_of_nodes(), "road_edges": road.number_of_edges(),
              "buildings": len(index["ids"]), "shelters": len(shelters["features"]),
              "places": sorted(found), "keywords_missing": sorted(set(keywords) - found)}
    return layers, sources, report
