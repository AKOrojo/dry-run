"""Impact statistics from depth grids (owner: Eng A).

Thresholds are ASSUMPTIONS and are shown as such in the UI and README.
Road checks are vectorised (np.maximum.reduceat over each edge's cells) so per-frame
series stay fast on a ~10^5-edge Lagos graph.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache

import networkx as nx
import numpy as np

from dryrun import storage

FLOODED_M = 0.15
SEVERE_M = 0.5
PASSABLE_M = 0.3  # vehicle/pedestrian passability default; configurable


@lru_cache(maxsize=4)
def building_cells(aoi_id: str) -> tuple[list[str], np.ndarray]:
    """(ids, [[row, col], ...]) from buildings_index.json. Cached per aoi_id (AOI ids are immutable)."""
    idx = json.loads(storage.load_aoi_file(aoi_id, "buildings"))
    return [str(i) for i in idx["ids"]], np.array([idx["row"], idx["col"]], int).T.reshape(-1, 2)


@lru_cache(maxsize=4)
def road_graph(aoi_id: str) -> nx.Graph:
    import io

    g = nx.read_graphml(io.BytesIO(storage.load_aoi_file(aoi_id, "roads_graph")))
    if g.is_multigraph() or g.is_directed():
        raise ValueError("roads_graph must be a simple undirected nx.Graph (see osm.py)")
    for _, _, d in g.edges(data=True):
        d["cells_arr"] = np.array(json.loads(d["cells"]), int).reshape(-1, 2)
        d["length_m"] = float(d["length_m"])
        d["bridge"] = int(d.get("bridge", 0))
        d["drive"] = int(d.get("drive", 1))
    return g


@dataclass(frozen=True)
class EdgeArrays:
    edges: list            # [(u, v), ...] in a fixed order
    flat: np.ndarray       # concatenated flat cell indices of all edges
    starts: np.ndarray     # start offset of each edge in `flat`
    length_m: np.ndarray
    drive: np.ndarray      # bool
    bridge: np.ndarray     # bool


@lru_cache(maxsize=4)
def edge_arrays(aoi_id: str) -> EdgeArrays:
    g = road_graph(aoi_id)
    nx_ = storage.load_aoi(aoi_id).grid.nx
    edges, flats, starts, n = [], [], [], 0
    for u, v, d in g.edges(data=True):
        c = d["cells_arr"]
        if len(c) == 0:  # reduceat would silently borrow the next edge's cells; osm.py must emit >= 2
            raise ValueError(f"road edge {u}-{v} has no cells (osm.py must include both endpoint cells)")
        edges.append((u, v))
        starts.append(n)
        flats.append(c[:, 0] * nx_ + c[:, 1])
        n += len(c)
    data = [g.edges[e] for e in edges]
    return EdgeArrays(edges, np.concatenate(flats) if flats else np.zeros(0, int), np.array(starts, int),
                      np.array([d["length_m"] for d in data]), np.array([d["drive"] for d in data], bool),
                      np.array([d["bridge"] for d in data], bool))


def edge_depths(ea: EdgeArrays, depth: np.ndarray, exclude: np.ndarray | None = None) -> np.ndarray:
    """Max depth along each edge (order = ea.edges); permanent water ignored; bridges always 0."""
    d = depth if exclude is None else np.where(exclude, 0.0, depth)
    if not len(ea.edges):
        return np.zeros(0)
    out = np.maximum.reduceat(d.ravel()[ea.flat], ea.starts)
    out[ea.bridge] = 0.0
    return out


def edges_touching(ea: EdgeArrays, mask: np.ndarray) -> np.ndarray:
    """Bool per edge: does the edge cross any cell of `mask`?"""
    if not len(ea.edges):
        return np.zeros(0, bool)
    return np.maximum.reduceat(mask.ravel()[ea.flat].astype(np.int8), ea.starts).astype(bool)


def cut_mask(aoi_id: str, depth: np.ndarray, exclude: np.ndarray, ponds: np.ndarray) -> np.ndarray:
    """Bool per edge: impassable (depth over threshold, or the road runs through a pond)."""
    ea = edge_arrays(aoi_id)
    return (edge_depths(ea, depth, exclude) >= PASSABLE_M) | edges_touching(ea, ponds)


def neighbourhood_max(depth: np.ndarray) -> np.ndarray:
    """3x3 max filter. Buildings sit on raised DSM cells; the water is around them."""
    p = np.pad(depth, 1, mode="edge")
    ny, nx_ = depth.shape
    return np.max([p[r:r + ny, c:c + nx_] for r in range(3) for c in range(3)], axis=0)


def clear_caches() -> None:
    building_cells.cache_clear()
    road_graph.cache_clear()
    edge_arrays.cache_clear()


def road_km_cut(aoi_id: str, cut: np.ndarray, region: np.ndarray | None = None) -> float:
    ea = edge_arrays(aoi_id)
    sel = cut & ea.drive  # drive graph only: walk edges would double count
    if region is not None:
        sel &= edges_touching(ea, region)
    return float(ea.length_m[sel].sum() / 1000)


def impact(aoi_id: str, max_depth: np.ndarray, cell_area_m2: float, exclude: np.ndarray,
           ponds: np.ndarray | None = None, region: np.ndarray | None = None) -> dict:
    """exclude = permanent water + pond cells: never counted as flooding.
    ponds = pond cells: buildings there are DISPLACED (own stat), roads there are cut.
    region = optional mask (a named place) restricting every stat."""
    ponds = np.zeros_like(exclude) if ponds is None else ponds
    reg = np.ones_like(exclude) if region is None else region
    wet_depth = np.where(exclude | ~reg, 0.0, max_depth)
    _, b = building_cells(aoi_id)
    if len(b):
        in_region, in_pond = reg[b[:, 0], b[:, 1]], ponds[b[:, 0], b[:, 1]]
        keep = in_region & ~exclude[b[:, 0], b[:, 1]]
        bd = neighbourhood_max(wet_depth)[b[keep, 0], b[keep, 1]]
        displaced = int((in_pond & in_region).sum())
    else:
        bd, displaced = np.zeros(0), 0
    pop = storage.load_raster(aoi_id, "population")
    wet = wet_depth >= FLOODED_M
    road_km = road_km_cut(aoi_id, cut_mask(aoi_id, max_depth, exclude, ponds), region)
    return {
        "buildings_flooded": int((bd >= FLOODED_M).sum()),
        "buildings_flooded_severe": int((bd >= SEVERE_M).sum()),
        "buildings_in_ponds": displaced,
        "road_km_impassable": round(road_km, 3),
        "people_exposed": int(pop[wet].sum()),
        "flooded_area_km2": round(float(wet.sum() * cell_area_m2 / 1e6), 4),
        "max_depth_m": round(float(wet_depth.max()), 3),
        "passability_threshold_m": PASSABLE_M,
    }
