"""Drain networks for the drainage model, contract 0.8.0 (owner: Eng A).

Builds, for one AOI grid, what dryrun/sim/drainage.py routes and what the UI draws:

drain_network.json  channels: one node per grid cell crossed by a drain (open drains, covered drains, ditches,
                    canals, streams from OSM, plus drains inferred along drivable roads), undirected links between
                    neighbouring nodes (the flow direction comes out of the water levels, so OSM way direction and
                    flat Lagos slopes do not matter), and outfalls where a node touches open water (boundary_mask).
                    sewer zones: lumped closed sewers, one per outfall catchment (Voronoi of the outfalls, NYC does
                    not publish its sewersheds), with area, inlet count, invert, lowest inlet ground and the cells
                    that surcharge first. features: drains_geojson line id -> its nodes (for drain_fill).
inlets_count.npy    float32, catch basins per cell (NYC DEP points; elsewhere one per INFERRED_INLET_SPACING_M of
                    drivable road).
sewer_zones.npy     int32, zone per land cell, -1 = none.
drains_geojson      the UI layer described in contracts/schemas.py (DRAINS_GEOJSON comment).

Every channel size here is an assumption: OSM has no drain widths and no public survey of Lekki drains exists
(docs/reports "Sewer and drain model design"). The values below follow that report: a 0.9 m concrete U-drain
for mapped roadside drains, two 0.6 m drains for an inferred road, Manning n 0.015 for concrete and 0.035-0.04
for earth.

Pure numpy + networkx (runs in CI). Grid rows run north to south (row 0 = north edge).
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import dataclass, field

import networkx as nx
import numpy as np

from dryrun.contracts import AOIManifest, GridSpec
from dryrun.pipeline import osm

NETWORK_VERSION = 1


@dataclass(frozen=True)
class Channel:
    ui_kind: str  # drains_geojson kind
    width_m: float
    depth_m: float
    manning: float
    covered: bool = False
    open_fraction: float = 1.0  # share of the length open to lateral inflow (both banks)


# OSM tag -> channel (assumed sizes, see module docstring)
CHANNELS = {
    "drain": Channel("open_drain", 0.9, 0.9, 0.015),
    "covered": Channel("covered_drain", 0.9, 0.9, 0.015, covered=True, open_fraction=0.0),
    "ditch": Channel("open_drain", 1.5, 1.0, 0.035),
    "canal": Channel("canal", 6.0, 2.5, 0.030),
    "stream": Channel("canal", 4.0, 1.5, 0.040),
    # a drain each side of a drivable road, lumped; slabs at crossings and driveways cover part of it
    "gutter": Channel("gutter_inferred", 1.2, 0.6, 0.015, open_fraction=0.7),
}
COVERED_INLET_SPACING_M = 15.0  # a grate or slot every 15 m on covered sections (assumed)
INFERRED_INLET_SPACING_M = 50.0  # catch basins along drivable roads where none are mapped (assumed)
DESIGN_SLOPE = 0.001  # bed slope for the network's nominal capacity (report: flat coastal Lekki, assumed)
ZONE_OUTFALL_SPACING_M = 1000.0  # outfalls closer than this share a zone
ZONE_MIN_INLETS = 50  # smaller zones merge into their nearest neighbour
ZONE_TILE_M = 500.0  # outfall catchments split into ~500 m tiles: local pipes are sized for local area, so a
#                       downpour on one tile must not use the spare capacity of a dry tile 3 km away
SURCHARGE_QUANTILE = 0.10  # a zone overflows first at its lowest 10 % of inlet cells


@dataclass
class Network:
    """The drain_network.json document, as arrays (flat cell index = row * nx + col)."""

    node_cell: list[int] = field(default_factory=list)
    node_channel: list[str] = field(default_factory=list)
    link_a: list[int] = field(default_factory=list)
    link_b: list[int] = field(default_factory=list)
    link_len: list[float] = field(default_factory=list)
    outfall_node: list[int] = field(default_factory=list)
    features: list[dict] = field(default_factory=list)  # {id, kind, channel, name, osm_id, nodes, coords}


def _flat(rc, nx_: int) -> int:
    return int(rc[0]) * nx_ + int(rc[1])


def cell_lonlat(grid: GridSpec, r, c) -> tuple[np.ndarray, np.ndarray]:
    w, s, e, n = grid.bounds_wgs84
    return (w + (np.asarray(c, float) + 0.5) * (e - w) / grid.nx,
            n - (np.asarray(r, float) + 0.5) * (n - s) / grid.ny)


def _centre_dist(grid: GridSpec, a: int, b: int) -> float:
    ra, ca = divmod(a, grid.nx)
    rb, cb = divmod(b, grid.nx)
    return math.hypot((ca - cb) * grid.dx_m, (ra - rb) * grid.dy_m)


def osm_channel(props: dict) -> str | None:
    """OSM waterway tags -> CHANNELS key, or None (not a drain we route)."""
    ww = props.get("waterway")
    if ww not in ("drain", "ditch", "canal", "stream"):
        return None
    covered = props.get("tunnel") in ("culvert", "yes", "flooded") or props.get("covered") == "yes"
    if covered and ww in ("drain", "ditch"):
        return "covered"
    return ww


def network(grid: GridSpec, lines: list[dict], boundary: np.ndarray, road_edges: list[dict] | None = None) -> Network:
    """Channel network on the grid.

    lines: [{"channel": CHANNELS key, "coords": [(lon, lat), ...], "osm_id": str|None, "name": str|None}]
    road_edges: [{"cells": [[r, c], ...]}] drivable road edges for inferred gutters, drawn through
        their cell centres (None = no gutters).
    A cell crossed by several channels keeps the largest cross-section. Cells in boundary (open water) carry
    no node: a line entering open water ends at an outfall on its last land cell.
    """
    nx_ = grid.nx
    bnd = np.asarray(boundary, bool).reshape(-1)
    best: dict[int, str] = {}
    seqs: list[tuple[dict, list[int]]] = []

    def area(key):
        ch = CHANNELS[key]
        return ch.width_m * ch.depth_m

    items = [dict(ln, source="osm") for ln in lines]
    for k, e in enumerate(road_edges or []):
        items.append({"channel": "gutter", "cells": e["cells"], "coords": None, "osm_id": None,
                      "name": None, "source": "inferred", "edge": k})
    for it in items:
        cells = it.get("cells") or osm.line_cells(grid, it["coords"])
        flat = [_flat(rc, nx_) for rc in cells]
        land = [c for c in flat if not bnd[c]]
        if not land:
            continue
        for c in land:
            if c not in best or area(it["channel"]) > area(best[c]):
                best[c] = it["channel"]
        seqs.append((it, flat))

    net = Network()
    index: dict[int, int] = {}
    for c in sorted(best):
        index[c] = len(net.node_cell)
        net.node_cell.append(c)
        net.node_channel.append(best[c])

    links: dict[tuple[int, int], float] = {}
    outfalls: set[int] = set()
    endpoints: list[int] = []
    for it, flat in seqs:
        nodes: list[int] = []
        prev = None
        for c in flat:
            if bnd[c]:
                if prev is not None:
                    outfalls.add(index[prev])  # the line runs into open water here
                prev = None
                continue
            if prev is not None and prev != c:
                a, b = sorted((index[prev], index[c]))
                links[(a, b)] = _centre_dist(grid, prev, c)
            if not nodes or nodes[-1] != index[c]:
                nodes.append(index[c])
            prev = c
        if not nodes:
            continue
        endpoints += [nodes[0], nodes[-1]]
        ch = CHANNELS[it["channel"]]
        prefix = {"gutter_inferred": "gutter", "canal": "canal"}.get(ch.ui_kind, "drain")
        fid = (f"{prefix}:{it['edge']}" if it["source"] == "inferred"
               else f"{prefix}:osm-{it['osm_id']}" if it.get("osm_id") else f"{prefix}:{len(net.features)}")
        coords = it.get("coords")
        if not coords:
            rr, cc = np.divmod(np.array(flat), nx_)
            coords = list(zip(*cell_lonlat(grid, rr, cc)))
        net.features.append({"id": fid, "kind": ch.ui_kind, "channel": it["channel"], "name": it.get("name"),
                             "source": it["source"], "nodes": nodes, "coords": [list(map(float, p)) for p in coords]})

    # a line ending one cell short of another channel joins it (OSM drains often stop at the road they feed)
    linked = Counter()
    for a, b in links:
        linked[a] += 1
        linked[b] += 1
    ny_ = grid.ny
    for nd in set(endpoints):
        if linked[nd] > 1:
            continue
        r, c = divmod(net.node_cell[nd], nx_)
        best_nb, best_d = None, math.inf
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                rr, cc = r + dr, c + dc
                if (dr or dc) and 0 <= rr < ny_ and 0 <= cc < nx_:
                    nb = index.get(rr * nx_ + cc)
                    if nb is not None and (min(nd, nb), max(nd, nb)) not in links:
                        d = math.hypot(dc * grid.dx_m, dr * grid.dy_m)
                        if d < best_d:
                            best_nb, best_d = nb, d
        if best_nb is not None:
            links[(min(nd, best_nb), max(nd, best_nb))] = best_d

    # any node beside open water (4-neighbour) also discharges there
    b2 = bnd.reshape(grid.ny, nx_)
    for nd, c in enumerate(net.node_cell):
        r, cc = divmod(c, nx_)
        for rr, c2 in ((r - 1, cc), (r + 1, cc), (r, cc - 1), (r, cc + 1)):
            if 0 <= rr < grid.ny and 0 <= c2 < nx_ and b2[rr, c2]:
                outfalls.add(nd)
                break

    for (a, b), d in sorted(links.items()):
        net.link_a.append(a)
        net.link_b.append(b)
        net.link_len.append(round(d, 2))
    net.outfall_node = sorted(outfalls)
    return net


def node_lengths(grid: GridSpec, net: Network) -> np.ndarray:
    """Channel length each node stands for: half its links, at least one cell (an isolated node is one cell)."""
    L = np.zeros(len(net.node_cell))
    for a, b, d in zip(net.link_a, net.link_b, net.link_len):
        L[a] += d / 2
        L[b] += d / 2
    return np.maximum(L, min(grid.dx_m, grid.dy_m))


def full_flow_m3s(channel: str, slope: float = DESIGN_SLOPE) -> float:
    """Manning full-bank discharge of a rectangular channel."""
    ch = CHANNELS[channel]
    a = ch.width_m * ch.depth_m
    r = a / (ch.width_m + 2 * ch.depth_m)
    return a * r ** (2 / 3) * math.sqrt(slope) / ch.manning


def nominal_capacity_mm_h(net: Network, land_area_m2: float) -> float:
    """What the outfalls carry at full bank on DESIGN_SLOPE, over the land area: the open system's design rate."""
    q = sum(full_flow_m3s(net.node_channel[o]) for o in net.outfall_node)
    return 0.0 if land_area_m2 <= 0 else q / land_area_m2 * 3.6e6


# -------------------------------------------------------------------------------------------- inlets
def inlets_from_points(grid: GridSpec, lonlat: np.ndarray, land: np.ndarray) -> np.ndarray:
    """Catch-basin points -> count per cell (points outside the grid or on open water dropped)."""
    out = np.zeros((grid.ny, grid.nx), np.float32)
    lonlat = np.asarray(lonlat, float).reshape(-1, 2)
    keep = osm.in_grid(grid, lonlat[:, 0], lonlat[:, 1])
    r, c = osm.cell_of(grid, lonlat[keep, 0], lonlat[keep, 1])
    np.add.at(out, (r, c), 1.0)
    out[~np.asarray(land, bool)] = 0
    return out


def inlets_along_roads(grid: GridSpec, road_edges: list[dict], land: np.ndarray,
                       spacing_m: float = INFERRED_INLET_SPACING_M) -> np.ndarray:
    """One inlet per spacing_m of drivable road, spread over the cells each edge crosses."""
    out = np.zeros((grid.ny, grid.nx), np.float32)
    for e in road_edges:
        cells = np.unique(np.asarray(e["cells"], int).reshape(-1, 2), axis=0)
        np.add.at(out, (cells[:, 0], cells[:, 1]), float(e["length_m"]) / spacing_m / len(cells))
    out[~np.asarray(land, bool)] = 0
    return out


# --------------------------------------------------------------------------------------------- zones
def _xy(grid: GridSpec, lon, lat) -> tuple[np.ndarray, np.ndarray]:
    lat0 = 0.5 * (grid.bounds_wgs84[1] + grid.bounds_wgs84[3])
    return np.asarray(lon, float) * osm._m_per_deg_lon(lat0), np.asarray(lat, float) * osm.M_PER_DEG_LAT


def thin_points(grid: GridSpec, pts: list[dict], spacing_m: float | None = None) -> list[dict]:
    """Greedy: keep a point unless one already kept lies within spacing_m (default ZONE_OUTFALL_SPACING_M;
    input order = priority)."""
    spacing_m = ZONE_OUTFALL_SPACING_M if spacing_m is None else spacing_m
    kept: list[dict] = []
    kx: list[float] = []
    ky: list[float] = []
    for p in pts:
        x, y = _xy(grid, p["lon"], p["lat"])
        if kx and np.min(np.hypot(np.array(kx) - x, np.array(ky) - y)) < spacing_m:
            continue
        kept.append(p)
        kx.append(float(x))
        ky.append(float(y))
    return kept


def _nearest(grid: GridSpec, cells: np.ndarray, pts: list[dict]) -> np.ndarray:
    r, c = np.divmod(cells, grid.nx)
    x, y = _xy(grid, *cell_lonlat(grid, r, c))
    px, py = _xy(grid, [p["lon"] for p in pts], [p["lat"] for p in pts])
    out = np.empty(len(cells), np.int32)
    for s in range(0, len(cells), 20000):
        d = (x[s:s + 20000, None] - px[None]) ** 2 + (y[s:s + 20000, None] - py[None]) ** 2
        out[s:s + 20000] = d.argmin(1)
    return out


def zones(grid: GridSpec, land: np.ndarray, inlets: np.ndarray, dem: np.ndarray, outfalls: list[dict],
          places: list[dict] | None = None, min_inlets: int | None = None) -> tuple[np.ndarray, list[dict]]:
    """Lumped sewer zones: every land cell drains to its nearest outfall (after thinning to
    ZONE_OUTFALL_SPACING_M); catchments with fewer than min_inlets inlets merge into the next nearest. Each
    catchment is then cut into ZONE_TILE_M tiles (tiles with fewer than min_inlets inlets join the catchment's
    largest tile); every tile is one zone draining to its catchment's outfall.

    outfalls: [{"lon", "lat", "receiving", "gated", "invert_m", "name"?}] in priority order.
    places: [{"name", "ring": [(lon, lat), ...]}] to name zones by the neighbourhood holding most of their cells.
    Returns (zone id per cell, -1 off land; zone records).
    """
    min_inlets = ZONE_MIN_INLETS if min_inlets is None else min_inlets
    land = np.asarray(land, bool)
    zid = np.full(land.shape, -1, np.int32)
    cells = np.flatnonzero(land.reshape(-1))
    pts = thin_points(grid, outfalls)
    if not len(cells) or not pts:
        return zid, []
    inl = np.asarray(inlets, float).reshape(-1)
    active = list(range(len(pts)))
    while True:
        near = np.array(active)[_nearest(grid, cells, [pts[i] for i in active])]
        counts = np.bincount(near, weights=inl[cells], minlength=len(pts))
        small = [i for i in active if counts[i] < min_inlets]
        if not small or len(active) == 1:
            break
        if len(small) == len(active):  # nothing big enough: keep the one with most inlets
            active = [max(active, key=lambda i: counts[i])]
            continue
        active = [i for i in active if i not in small]

    rings = []
    for p in places or []:
        ring = np.asarray(p["ring"], float)
        rings.append((p["name"], ring))
    pr, pc = np.divmod(cells, grid.nx)
    plon, plat = cell_lonlat(grid, pr, pc)
    place_of = np.full(len(cells), -1)
    for k, (_, ring) in enumerate(rings):
        inside = _in_ring(plon, plat, ring) & (place_of < 0)
        place_of[inside] = k

    tx = np.floor(pc * grid.dx_m / ZONE_TILE_M).astype(np.int64)
    ty = np.floor(pr * grid.dy_m / ZONE_TILE_M).astype(np.int64)
    tile = ty * 100000 + tx
    groups: list[tuple[int, np.ndarray]] = []
    for i in active:
        sel = near == i
        tiles = tile[sel]
        uniq, inv = np.unique(tiles, return_inverse=True)
        tin = np.bincount(inv, weights=inl[cells[sel]], minlength=len(uniq))
        big = tin >= min_inlets
        if not big.any():
            big[np.argmax(tin)] = True
        host = np.flatnonzero(big)[np.argmax(tin[big])]
        inv = np.where(big[inv], inv, host)
        idx = np.flatnonzero(sel)
        for u in np.flatnonzero(big):
            groups.append((i, idx[inv == u]))

    recs: list[dict] = []
    names: Counter = Counter()
    z = np.asarray(dem, float).reshape(-1)
    area = grid.dx_m * grid.dy_m
    for i, sel in groups:
        zc = cells[sel]
        k = len(recs)
        zid.reshape(-1)[zc] = k
        inlet_cells = zc[inl[zc] > 0]
        ground = z[inlet_cells] if len(inlet_cells) else z[zc]
        cut = np.quantile(ground, SURCHARGE_QUANTILE)
        low = (inlet_cells if len(inlet_cells) else zc)[ground <= cut]
        p = pts[i]
        pl = place_of[sel]
        pl = pl[pl >= 0]
        name = rings[np.bincount(pl).argmax()][0] if len(pl) else (p.get("name") or p["receiving"])
        names[name] += 1
        if names[name] > 1:
            name = f"{name} {names[name]}"
        recs.append({"id": k, "name": name, "area_m2": round(float(len(zc) * area), 1),
                     "inlets": round(float(inl[zc].sum()), 1), "outfall_lonlat": [p["lon"], p["lat"]],
                     "receiving": p["receiving"], "gated": bool(p["gated"]), "invert_m": float(p["invert_m"]),
                     "z_low_m": round(float(np.quantile(ground, 0.05)), 3),
                     "surcharge_cells": [int(v) for v in low]})
    return zid, recs


def _in_ring(x: np.ndarray, y: np.ndarray, ring: np.ndarray) -> np.ndarray:
    """Even-odd point-in-polygon for arrays of points."""
    inside = np.zeros(len(x), bool)
    xr, yr = ring[:, 0], ring[:, 1]
    j = len(ring) - 1
    for i in range(len(ring)):
        cross = ((yr[i] > y) != (yr[j] > y))
        with np.errstate(divide="ignore", invalid="ignore"):
            xi = (xr[j] - xr[i]) * (y - yr[i]) / (yr[j] - yr[i]) + xr[i]
        inside ^= cross & (x < xi)
        j = i
    return inside


def region_polygons(grid: GridSpec, mask: np.ndarray) -> list[list[list[list[float]]]]:
    """Cell mask -> GeoJSON MultiPolygon coordinates (outer rings counter-clockwise, holes clockwise), traced
    along cell edges; straight runs collapse to their end vertices."""
    m = np.pad(np.asarray(mask, bool), 1)
    edges: dict[tuple[int, int], list[tuple[int, int]]] = {}

    def add(a, b):
        edges.setdefault(a, []).append(b)

    # corners (i, j) = row line i, column line j of the unpadded grid; walk with the region on the left
    ys, xs = np.nonzero(m[1:-1, 1:-1])
    for r, c in zip(ys.tolist(), xs.tolist()):
        R, C = r + 1, c + 1
        if not m[R - 1, C]:
            add((r, c + 1), (r, c))  # north edge, westward
        if not m[R + 1, C]:
            add((r + 1, c), (r + 1, c + 1))  # south edge, eastward
        if not m[R, C - 1]:
            add((r, c), (r + 1, c))  # west edge, southward
        if not m[R, C + 1]:
            add((r + 1, c + 1), (r, c + 1))  # east edge, northward
    rings = []
    while edges:
        start = next(iter(edges))
        ring = [start]
        cur, prev_dir = start, None
        while True:
            outs = edges[cur]
            if len(outs) > 1 and prev_dir is not None:  # pinch corner: turn left first (keeps regions apart)
                outs.sort(key=lambda b: _turn(prev_dir, (b[0] - cur[0], b[1] - cur[1])))
            nxt = outs.pop(0)
            if not outs:
                del edges[cur]
            prev_dir = (nxt[0] - cur[0], nxt[1] - cur[1])
            cur = nxt
            if cur == start:
                break
            ring.append(cur)
        rings.append(ring)

    w, s, e, n = grid.bounds_wgs84
    sx, sy = (e - w) / grid.nx, (n - s) / grid.ny
    polys: list[list] = []
    holes = []
    for ring in rings:
        ring = _collapse(ring)
        pts = [[round(w + j * sx, 6), round(n - i * sy, 6)] for i, j in ring]
        pts.append(pts[0])
        a = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:])) / 2
        if a > 0:
            polys.append([pts])
        else:
            holes.append(pts)
    for h in holes:
        hx, hy = h[0]
        for p in polys:
            if _in_ring(np.array([hx + 1e-9]), np.array([hy + 1e-9]), np.asarray(p[0]))[0]:
                p.append(h)
                break
    return polys


def _turn(d0, d1) -> int:
    """0 = left turn, 1 = straight, 2 = right (row axis points south, so 'left' of east is north)."""
    cross = d0[1] * d1[0] - d0[0] * d1[1]
    return 0 if cross < 0 else (1 if cross == 0 else 2)


def _collapse(ring: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out = []
    n = len(ring)
    for k in range(n):
        a, b, c = ring[k - 1], ring[k], ring[(k + 1) % n]
        if (b[0] - a[0]) * (c[1] - b[1]) != (b[1] - a[1]) * (c[0] - b[0]):
            out.append(b)
    return out or ring


# --------------------------------------------------------------------------------------------- output
def network_doc(grid: GridSpec, net: Network, zid: np.ndarray, zone_recs: list[dict], outfall_receiving: str,
                outfall_gated: bool, land_area_m2: float) -> dict:
    L = node_lengths(grid, net)
    ch = [CHANNELS[k] for k in net.node_channel]
    return {
        "version": NETWORK_VERSION, "nx": grid.nx, "ny": grid.ny,
        "nodes": {
            "cell": net.node_cell, "channel": net.node_channel,
            "width_m": [c.width_m for c in ch], "depth_m": [c.depth_m for c in ch],
            "manning": [c.manning for c in ch], "length_m": [round(float(v), 2) for v in L],
            "weir_m": [round(float(2 * ln * c.open_fraction), 2) for ln, c in zip(L, ch)],
            "inlets": [round(float(ln / COVERED_INLET_SPACING_M), 2) if c.covered else 0.0 for ln, c in zip(L, ch)],
        },
        "links": {"a": net.link_a, "b": net.link_b, "length_m": net.link_len},
        "outfalls": {"node": net.outfall_node, "receiving": outfall_receiving, "gated": outfall_gated},
        "zones": zone_recs,
        "features": [{"id": f["id"], "kind": f["kind"], "nodes": f["nodes"]} for f in net.features],
        "nominal_capacity_mm_h": round(nominal_capacity_mm_h(net, land_area_m2), 1),
        "zone_cells": int((np.asarray(zid) >= 0).sum()),
    }


def drains_geojson(grid: GridSpec, net: Network, zid: np.ndarray, zone_recs: list[dict], capacity_mm_h: float,
                   inlet_points: np.ndarray | None, outfall_receiving: str, outfall_gated: bool) -> dict:
    feats = []
    for f in net.features:
        ch = CHANNELS[f["channel"]]
        line = [[round(x, 6), round(y, 6)] for x, y in f["coords"]]
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": line},
                      "properties": {"id": f["id"], "kind": ch.ui_kind, "width_m": ch.width_m, "depth_m": ch.depth_m,
                                     "source": f["source"], "name": f["name"]}})
    for z in zone_recs:
        polys = region_polygons(grid, np.asarray(zid) == z["id"])
        feats.append({"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": polys},
                      "properties": {"id": f"zone:{z['id']}", "kind": "sewer_zone", "name": z["name"],
                                     "capacity_mm_h": capacity_mm_h, "inlets": z["inlets"],
                                     "receiving": z["receiving"], "gated": z["gated"]}})
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": z["outfall_lonlat"]},
                      "properties": {"id": f"outfall:zone-{z['id']}", "kind": "outfall", "name": z["name"],
                                     "receiving": z["receiving"], "gated": z["gated"]}})
    if inlet_points is not None:
        for k, (lon, lat) in enumerate(np.asarray(inlet_points, float).reshape(-1, 2)):
            if osm.in_grid(grid, lon, lat):
                feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 6),
                                                                                                round(lat, 6)]},
                              "properties": {"id": f"inlet:{k}", "kind": "inlet"}})
    # channel mouths of mapped drains (inferred gutters reach open water all along the shore: not drawn)
    mapped = {n for f in net.features if f["source"] == "osm" for n in f["nodes"]}
    for nd in net.outfall_node:
        if nd in mapped:
            r, c = divmod(net.node_cell[nd], grid.nx)
            lon, lat = cell_lonlat(grid, r, c)
            feats.append({"type": "Feature", "geometry": {"type": "Point",
                                                           "coordinates": [round(float(lon), 6), round(float(lat), 6)]},
                          "properties": {"id": f"outfall:node-{nd}", "kind": "outfall", "name": None,
                                         "receiving": outfall_receiving, "gated": outfall_gated}})
    return {"type": "FeatureCollection", "features": feats}


def road_edges(g: nx.Graph) -> list[dict]:
    """Drivable edges of an AOI roads_graph: cells and length. Bridges stay: the drains along a road discharge into
    the canal it crosses (the shared cell links them)."""
    out = []
    for u, v, d in g.edges(data=True):
        if str(d.get("drive")) != "1":
            continue
        cells = json.loads(d["cells"]) if isinstance(d["cells"], str) else d["cells"]
        out.append({"cells": cells, "length_m": float(d["length_m"])})
    return out


# ---------------------------------------------------------------------------------------------- AOIs
# Per-city defaults (contract DrainageDefault). Values and sources: docs/reports "Sewer and drain model design".
NYC_OUTFALL_TYPES = ("CSO", "MS4", "DIRECT")  # combined-sewer overflows first, then storm outfalls
NYC_OUTFALL_INVERT_M = 0.0  # NAVD88; inverts are not published (assumed near mean sea level)

PROFILES = {
    "nyc-queens": dict(
        system="closed", label="Closed sewers: catch basins into combined-sewer pipes", capacity_mm_h=38.1,
        return_period_yr=3, design_mm_h_by_return_period={"3": 38.1, "5": 44.5, "10": 54.1},
        blockage_pct=10.0, blockage_range_pct=(0.0, 50.0), flap_gates=True, roadside_gutters=False,
        receiving="East River, Flushing Bay and Flushing Creek", runoff_coefficient=0.85, storage_mm=12.0,
        limits=[
            "Sewers are lumped per outfall catchment: no pipes, manholes or basements, and no single overflowing "
            "inlet can be named.",
            "Sewer catchments are drawn around outfalls because NYC does not publish its sewersheds.",
            "Capacity is the 1.5 in/h pre-1973 Queens design standard; actual capacity varies street by street.",
            "Catch basins are treated as identical curb grates; outfall inverts and tide gates are assumed.",
        ],
        sources=["NYC DEP catch basins (NYC Open Data 2w2g-fk3i)", "NYC DEP outfalls (NYC Open Data 8rjn-kpsh)",
                 "NYC DEP 2024 Stormwater Analysis Report (design 1.5-1.75 in/h)", "FHWA HEC-22 (inlet equations)"]),
    "lagos-lekki": dict(
        system="open", label="Open roadside drains with covered sections, into the Lagos Lagoon", capacity_mm_h=None,
        return_period_yr=None, design_mm_h_by_return_period={}, blockage_pct=25.0, blockage_range_pct=(0.0, 80.0),
        flap_gates=False, roadside_gutters=True, receiving="Lagos Lagoon", runoff_coefficient=0.85, storage_mm=0.0,
        limits=[
            "Drain sizes are assumed (no survey of Lekki drains is public): read results as relative "
            "susceptibility, not absolute depths.",
            "Most roadside drains are inferred from the road map, because OpenStreetMap maps only 2-3 % of them.",
            "Blockage is a scenario setting: no measured blockage for Lekki exists.",
            "The lagoon level at the drain mouths is the tide setting; no lagoon gauge is public.",
        ],
        sources=["OpenStreetMap waterway=drain|ditch|canal|stream (ODbL)", "OpenStreetMap drivable roads (ODbL)",
                 "FHWA HEC-22 (weir equations)", "SWMM 5.2 manual (Manning n)"]),
}


def _profile(aoi_id: str) -> dict:
    for k, v in PROFILES.items():
        if aoi_id.startswith(k):
            return dict(v)
    raise ValueError(f"no drainage profile for {aoi_id}")


def _places(folder) -> list[dict]:
    import pathlib

    p = pathlib.Path(folder) / "places.geojson"
    if not p.exists():
        return []
    out = []
    for f in json.loads(p.read_text())["features"]:
        if f["geometry"]["type"] == "Polygon" and f["properties"].get("kind", "neighbourhood") != "open_land":
            out.append({"name": f["properties"]["name"], "ring": f["geometry"]["coordinates"][0]})
    return out


def build_aoi(src_dir: str, dst_dir: str, new_id: str, raw_dir: str) -> dict:
    """Copy a published AOI folder to dst_dir as new_id and add the drainage layers and drainage_default.

    raw_dir: data/raw/<city>/drains (D's filed sources). Returns the new manifest dict.
    """
    import pathlib
    import shutil

    from dryrun.contracts.schemas import AOIManifest, DrainageDefault

    src, dst, raw = pathlib.Path(src_dir), pathlib.Path(dst_dir), pathlib.Path(raw_dir)
    if dst.exists():
        raise FileExistsError(f"{dst} exists: AOI ids are immutable")
    man = json.loads((src / "manifest.json").read_text())
    grid = GridSpec(**man["grid"])
    dem = np.load(src / man["layers"]["dem"])
    bnd = np.load(src / man["layers"]["boundary_mask"]).astype(bool)
    excl = np.load(src / man["layers"]["exclude_mask"]).astype(bool)
    land = ~bnd & ~excl
    roads = road_edges(nx.read_graphml(src / man["layers"]["roads_graph"]))
    places = _places(src)
    prof = _profile(new_id)
    land_area = float(land.sum() * grid.dx_m * grid.dy_m)

    lines, inlet_pts, outfalls = [], None, []
    lagos = new_id.startswith("lagos")
    if lagos:
        for f in json.loads((raw / "lagos_drains.geojson").read_text())["features"]:
            if f["geometry"]["type"] != "LineString":
                continue
            ch = osm_channel(f["properties"])
            if ch:
                lines.append({"channel": ch, "coords": f["geometry"]["coordinates"],
                              "osm_id": f.get("id") or f["properties"].get("@id") or f["properties"].get("osm_id"),
                              "name": f["properties"].get("name")})
    net = network(grid, lines, bnd, roads)
    if lagos:
        inlets = inlets_along_roads(grid, roads, land)
        mapped = {n for f in net.features if f["source"] == "osm" for n in f["nodes"]}
        order = sorted(net.outfall_node, key=lambda nd: (nd not in mapped, -full_flow_m3s(net.node_channel[nd])))
        for nd in order:
            r, c = divmod(net.node_cell[nd], grid.nx)
            lon, lat = cell_lonlat(grid, r, c)
            outfalls.append({"lon": round(float(lon), 6), "lat": round(float(lat), 6), "receiving": prof["receiving"],
                             "gated": prof["flap_gates"],
                             "invert_m": round(float(dem[r, c]) - CHANNELS[net.node_channel[nd]].depth_m, 3)})
        prof["capacity_mm_h"] = round(nominal_capacity_mm_h(net, land_area), 1)
    else:
        cb = json.loads((raw / "nyc_catch_basins.json").read_text())
        inlet_pts = np.array([[float(p["longitude"]), float(p["latitude"])] for p in cb])
        inlets = inlets_from_points(grid, inlet_pts, land)
        w, s, e, n = grid.bounds_wgs84
        pad = 2000 / osm.M_PER_DEG_LAT
        raw_of = [o for o in json.loads((raw / "nyc_outfalls.json").read_text())
                  if o.get("outfall_ty") in NYC_OUTFALL_TYPES
                  and w - pad <= float(o["longitude"]) <= e + pad and s - pad <= float(o["latitude"]) <= n + pad]
        raw_of.sort(key=lambda o: NYC_OUTFALL_TYPES.index(o["outfall_ty"]))
        for o in raw_of:
            outfalls.append({"lon": float(o["longitude"]), "lat": float(o["latitude"]),
                             "receiving": (o.get("receiving_") or prof["receiving"]).title(),
                             "gated": prof["flap_gates"], "invert_m": NYC_OUTFALL_INVERT_M, "name": o["unitid"]})
    zid, zrecs = zones(grid, land, inlets, dem, outfalls, places)
    doc = network_doc(grid, net, zid, zrecs, prof["receiving"], prof["flap_gates"], land_area)
    gj = drains_geojson(grid, net, zid, zrecs, prof["capacity_mm_h"], inlet_pts, prof["receiving"],
                        prof["flap_gates"])

    shutil.copytree(src, dst)
    (dst / "drain_network.json").write_text(json.dumps(doc, separators=(",", ":")))
    np.save(dst / "inlets_count.npy", inlets.astype(np.float32))
    np.save(dst / "sewer_zones.npy", zid.astype(np.int32))
    (dst / "drains.geojson").write_text(json.dumps(gj, separators=(",", ":")))
    version = new_id.rsplit("-", 1)[-1]
    man.update(aoi_id=new_id, contract_version="0.8.0", name=re.sub(r"\(v\d+\)", f"({version})", man["name"]))
    man["layers"].update(drain_network="drain_network.json", inlets_count="inlets_count.npy",
                         sewer_zones="sewer_zones.npy", drains_geojson="drains.geojson")
    for k in ("drain_network", "inlets_count", "sewer_zones", "drains_geojson"):
        man["sources"][k] = "; ".join(prof["sources"])
    man["drainage_default"] = DrainageDefault(**prof).model_dump(mode="json")
    AOIManifest(**man)  # validate
    (dst / "manifest.json").write_text(json.dumps(man, indent=2))
    return man


FIXTURE_ID = "fixture-drains"


def build_fixture() -> AOIManifest:
    """fixture-synthetic plus a drain network ("mixed": the synthetic canal as a channel, drains along every
    road, inlets every 50 m of road, sewer zones draining to the lagoon), so UI work and tests have every
    drainage field without real data. Written through storage like pipeline/fixtures.py."""
    from dryrun import storage
    from dryrun.contracts.schemas import AOIManifest, DrainageDefault
    from dryrun.pipeline import fixtures

    base = fixtures.build()
    grid = base.grid
    src = fixtures.AOI_ID

    def r(name):
        return storage.load_raster(src, name)

    dem, bnd, excl = r("dem"), r("boundary_mask") > 0.5, r("exclude_mask") > 0.5
    land = ~bnd & ~excl
    import io

    roads = road_edges(nx.read_graphml(io.BytesIO(storage.load_aoi_file(src, "roads_graph"))))
    canal = excl & ~bnd  # the synthetic canal
    rows = np.flatnonzero(canal.any(1))
    coords = [cell_lonlat(grid, rr, int(np.flatnonzero(canal[rr]).mean()))
              for rr in rows]
    lines = [{"channel": "canal", "coords": [(float(x), float(y)) for x, y in coords], "osm_id": None,
              "name": "Canal (synthetic)"}]
    net = network(grid, lines, bnd, roads)
    inlets = inlets_along_roads(grid, roads, land)
    outs = []
    for nd in net.outfall_node:
        rr, cc = divmod(net.node_cell[nd], grid.nx)
        lon, lat = cell_lonlat(grid, rr, cc)
        outs.append({"lon": float(lon), "lat": float(lat), "receiving": "Lagoon (synthetic)", "gated": False,
                     "invert_m": round(float(dem[rr, cc]) - 1.0, 3)})
    places = [{"name": f["properties"]["name"], "ring": f["geometry"]["coordinates"][0]}
              for f in json.loads(storage.load_aoi_file(src, "places"))["features"]
              if f["properties"]["kind"] != "open_land"]
    zid, zrecs = zones(grid, land, inlets, dem, outs, places)
    land_area = float(land.sum() * grid.dx_m * grid.dy_m)
    dflt = DrainageDefault(
        system="mixed", label="Synthetic: open drains and closed sewers", capacity_mm_h=40.0, return_period_yr=5,
        design_mm_h_by_return_period={"2": 30.0, "5": 40.0, "10": 50.0}, blockage_pct=20.0,
        blockage_range_pct=(0.0, 80.0), flap_gates=False, roadside_gutters=True, receiving="Lagoon (synthetic)",
        storage_mm=12.0, limits=["Synthetic network: not real drains."], sources=["synthetic"])
    doc = network_doc(grid, net, zid, zrecs, dflt.receiving, False, land_area)
    gj = drains_geojson(grid, net, zid, zrecs, dflt.capacity_mm_h, None, dflt.receiving, False)
    man = base.model_dump(mode="json")
    man.update(aoi_id=FIXTURE_ID, name="Synthetic fixture with drains (NOT real terrain)",
               drainage_default=dflt.model_dump(mode="json"))
    man["layers"].update(drain_network="drain_network.json", inlets_count="inlets_count.npy",
                         sewer_zones="sewer_zones.npy", drains_geojson="drains.geojson")
    for k in ("drain_network", "inlets_count", "sewer_zones", "drains_geojson"):
        man["sources"][k] = "synthetic (generated by pipeline/drains.py)"
    m = AOIManifest(**man)
    w = storage.write_aoi_file
    for name in base.layers.values():
        w(FIXTURE_ID, name, storage._read_bytes("data", f"{src}/{name}"))
    w(FIXTURE_ID, "drain_network.json", json.dumps(doc).encode(), "application/json")
    w(FIXTURE_ID, "inlets_count.npy", _npy(inlets))
    w(FIXTURE_ID, "sewer_zones.npy", _npy(zid.astype(np.int32)))
    w(FIXTURE_ID, "drains.geojson", json.dumps(gj).encode(), "application/geo+json")
    w(FIXTURE_ID, "manifest.json", m.model_dump_json(indent=2).encode(), "application/json")
    return m


def _npy(arr: np.ndarray) -> bytes:
    import io

    buf = io.BytesIO()
    np.save(buf, arr)
    return buf.getvalue()


def main() -> None:
    import argparse
    import pathlib
    import sys

    if sys.argv[1:] == ["--fixture"]:
        m = build_fixture()
        print(f"wrote AOI {m.aoi_id}")
        return
    ap = argparse.ArgumentParser(description="add drainage layers to a copy of a published AOI (or --fixture)")
    ap.add_argument("src_dir")
    ap.add_argument("dst_dir")
    ap.add_argument("new_id")
    ap.add_argument("raw_dir", help="data/raw/<city>/drains")
    a = ap.parse_args()
    man = build_aoi(a.src_dir, a.dst_dir, a.new_id, a.raw_dir)
    doc = json.loads((pathlib.Path(a.dst_dir) / "drain_network.json").read_text())
    print(f"{a.new_id}: {len(doc['nodes']['cell'])} channel nodes, {len(doc['links']['a'])} links, "
          f"{len(doc['outfalls']['node'])} outfalls, {len(doc['zones'])} zones, "
          f"default {man['drainage_default']['system']} {man['drainage_default']['capacity_mm_h']} mm/h")


if __name__ == "__main__":
    main()
