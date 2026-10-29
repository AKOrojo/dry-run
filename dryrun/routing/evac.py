"""Flood-aware evacuation routing (owner: Eng D).

Graph contract (roads_graph layer): simple undirected nx.Graph; nodes have x=lon, y=lat, row, col;
edges have length_m, `cells` = JSON [[row, col], ...] sampled along the geometry at <= 1 cell,
`drive` and `bridge` flags. An edge is cut when its max depth (permanent water and bridges
ignored) >= PASSABLE_M, when it crosses a pond, or when it crosses a road_closure area.
A shelter whose own cell is flooded (>= exposure.FLOODED_M) at the routed frame is not a destination.
"""

from __future__ import annotations

import json
from functools import lru_cache

import networkx as nx
import numpy as np

from dryrun import storage
from dryrun.contracts import RoadClosure, RouteRequest, RouteResult
from dryrun.sim import exposure, interventions

WALK_KMH = 4.0
MAX_SNAP_M = 300.0  # origin/destination/shelter must be within this of the road network


@lru_cache(maxsize=4)
def _node_index(aoi_id: str):
    g = exposure.road_graph(aoi_id)
    nodes = list(g.nodes)
    return nodes, np.array([[g.nodes[n]["x"], g.nodes[n]["y"]] for n in nodes], float)


def _nearest_node(aoi_id: str, lon: float, lat: float) -> str:
    """Raises ValueError if the point is > MAX_SNAP_M from any node (vectorised: ~1 ms per 10^5 nodes)."""
    nodes, xy = _node_index(aoi_id)
    dx = (xy[:, 0] - lon) * 111_320 * np.cos(np.radians(lat))
    dy = (xy[:, 1] - lat) * 110_574
    i = int(np.argmin(dx * dx + dy * dy))
    if np.hypot(dx[i], dy[i]) > MAX_SNAP_M:
        raise ValueError(f"point ({lon:.5f}, {lat:.5f}) is more than {MAX_SNAP_M:.0f} m from any road")
    return nodes[i]


@lru_cache(maxsize=16)
def _run_masks(run_id: str):
    m = storage.load_run(run_id)
    aoi = storage.load_aoi(m.scenario.aoi_id)
    exclude = storage.load_raster(aoi.aoi_id, "exclude_mask") > 0.5
    ponds = interventions.pond_mask(m.scenario, aoi.grid, exclude)
    closed = np.zeros_like(exclude)
    for iv in m.scenario.interventions:
        if isinstance(iv, RoadClosure):
            closed |= interventions.area_mask(m.scenario, aoi.grid, iv)
    return exclude | ponds, ponds, closed


@lru_cache(maxsize=256)
def cut_edges(run_id: str, frame_depth: str, aoi_id: str) -> frozenset:
    """Edges impassable at one frame of one run. Cached: runs are immutable."""
    exclude, ponds, closed = _run_masks(run_id)
    ea = exposure.edge_arrays(aoi_id)
    cut = exposure.cut_mask(aoi_id, storage.load_depth(run_id, frame_depth), exclude, ponds | closed)
    return frozenset(e for e, c in zip(ea.edges, cut, strict=True) if c)


def route(req: RouteRequest) -> RouteResult:
    m = storage.load_run(req.run_id)
    if not m.frames:
        raise ValueError(f"run {req.run_id} is {m.status.value}; nothing to route on")
    aoi = storage.load_aoi(m.scenario.aoi_id)
    frame = min(m.frames, key=lambda f: abs(f.t_s - req.t_s))
    cut = cut_edges(m.run_id, frame.depth, aoi.aoi_id)
    g = nx.restricted_view(exposure.road_graph(aoi.aoi_id), [], list(cut))  # no graph copy

    src = _nearest_node(aoi.aoi_id, *req.origin)  # ValueError -> API 400
    if req.destination is not None:
        targets = {_nearest_node(aoi.aoi_id, *req.destination): None}
    else:
        targets = {}
        depth = storage.load_depth(m.run_id, frame.depth)
        for f in json.loads(storage.load_aoi_file(aoi.aoi_id, "shelters"))["features"]:
            p = f["properties"]
            if "row" in p and depth[int(p["row"]), int(p["col"])] >= exposure.FLOODED_M:
                continue  # a flooded shelter is no refuge
            try:  # one badly placed shelter must not break every route
                targets[_nearest_node(aoi.aoi_id, *f["geometry"]["coordinates"])] = f["properties"]["name"]
            except ValueError:
                continue
        if not targets:  # every shelter flooded or off-network: a real answer, not a bad request
            return RouteResult(run_id=req.run_id, t_s=frame.t_s, reachable=False, edges_removed=len(cut))

    dist, paths = nx.single_source_dijkstra(g, src, weight="length_m")  # one pass for all shelters
    reach = [(dist[t], t, n) for t, n in targets.items() if t in dist]
    if not reach:
        return RouteResult(run_id=req.run_id, t_s=frame.t_s, reachable=False, edges_removed=len(cut))
    length, tgt, name = min(reach)
    return RouteResult(
        run_id=req.run_id, t_s=frame.t_s, reachable=True,
        path=[(g.nodes[n]["x"], g.nodes[n]["y"]) for n in paths[tgt]],
        length_km=round(length / 1000, 3), eta_min=round(length / 1000 / WALK_KMH * 60, 1),
        edges_removed=len(cut), destination_name=name,
    )
