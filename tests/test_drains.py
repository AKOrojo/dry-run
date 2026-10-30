"""Drain-network builder (dryrun/pipeline/drains.py): pure numpy + networkx, no data files."""

import numpy as np
import pytest

from dryrun.contracts import GridSpec
from dryrun.contracts.schemas import Drainage, DrainageDefault, ScenarioSpec, Storm
from dryrun.pipeline import drains as D

W, S, E, N = 3.47, 6.42, 3.48, 6.43  # 36 x 36 one-arc-second cells
GRID = GridSpec(cell_size_m=30.6, dx_m=30.7, dy_m=30.5, nx=36, ny=36, bounds_wgs84=(W, S, E, N))
STEP = 1 / 3600


def _ll(r, c):
    return W + (c + 0.5) * STEP, N - (r + 0.5) * STEP


def _water_north():
    b = np.zeros((36, 36), bool)
    b[:3] = True  # open water along the north edge
    return b


def test_osm_channel_tags():
    assert D.osm_channel({"waterway": "drain"}) == "drain"
    assert D.osm_channel({"waterway": "drain", "tunnel": "culvert"}) == "covered"
    assert D.osm_channel({"waterway": "ditch", "covered": "yes"}) == "covered"
    assert D.osm_channel({"waterway": "canal", "tunnel": "culvert"}) == "canal"
    assert D.osm_channel({"waterway": "river"}) is None and D.osm_channel({"ford": "yes"}) is None


def test_network_links_outfall_and_largest_section_wins():
    drain = {"channel": "drain", "coords": [_ll(20, 10), _ll(2, 10)], "osm_id": "1", "name": "Main drain"}
    canal = {"channel": "canal", "coords": [_ll(20, 10), _ll(20, 20)], "osm_id": "2", "name": None}
    road = {"cells": [[25, c] for c in range(5, 16)]}
    net = D.network(GRID, [drain, canal], _water_north(), [road])
    cells = dict(zip(net.node_cell, net.node_channel))
    assert cells[20 * 36 + 10] == "canal"  # shared cell keeps the bigger channel
    assert all(not _water_north().reshape(-1)[c] for c in net.node_cell)  # no node on open water
    top = net.node_cell.index(3 * 36 + 10)
    assert top in net.outfall_node  # the drain runs into the water
    ids = {f["id"]: f for f in net.features}
    assert {"drain:osm-1", "canal:osm-2", "gutter:0"} <= set(ids)
    assert ids["gutter:0"]["kind"] == "gutter_inferred" and ids["drain:osm-1"]["name"] == "Main drain"
    # links follow the lines: the drain chain is connected
    n_drain = len(ids["drain:osm-1"]["nodes"])
    assert n_drain == 18 and len(net.link_a) >= n_drain - 1 + 10 + 10


def test_dangling_end_snaps_to_neighbouring_channel():
    a = {"channel": "drain", "coords": [_ll(10, 5), _ll(10, 15)], "osm_id": "1", "name": None}
    b = {"channel": "drain", "coords": [_ll(20, 16), _ll(11, 16)], "osm_id": "2", "name": None}  # stops beside a
    net = D.network(GRID, [a, b], np.zeros((36, 36), bool))
    idx = {c: k for k, c in enumerate(net.node_cell)}
    pair = tuple(sorted((idx[11 * 36 + 16], idx[10 * 36 + 15])))
    assert pair in set(zip(net.link_a, net.link_b))


def test_node_lengths_and_nominal_capacity():
    net = D.network(GRID, [{"channel": "drain", "coords": [_ll(20, 10), _ll(2, 10)], "osm_id": "1", "name": None}],
                    _water_north())
    L = D.node_lengths(GRID, net)
    assert L.min() >= 30.5 - 1e-9 and abs(L.sum() - (len(L) - 1) * 30.5) < 31
    q = D.full_flow_m3s("drain")
    assert 0.5 < q < 1.5  # 0.9 x 0.9 m concrete U-drain at 0.1 %
    land = 33 * 36 * GRID.dx_m * GRID.dy_m
    assert D.nominal_capacity_mm_h(net, land) == pytest.approx(q / land * 3.6e6)


def test_inlets_points_and_roads():
    land = ~_water_north()
    pts = np.array([_ll(10, 10), _ll(10, 10), _ll(1, 1), (0.0, 0.0)])
    a = D.inlets_from_points(GRID, pts, land)
    assert a[10, 10] == 2 and a.sum() == 2  # on water and outside the grid: dropped
    r = D.inlets_along_roads(GRID, [{"cells": [[20, c] for c in range(10)], "length_m": 500.0}], land)
    assert r.sum() == pytest.approx(10.0)


def test_zones_tiles_names_and_surcharge_cells(monkeypatch):
    monkeypatch.setattr(D, "ZONE_OUTFALL_SPACING_M", 300.0)
    monkeypatch.setattr(D, "ZONE_TILE_M", 600.0)
    land = ~_water_north()
    inlets = np.where(land, 1.0, 0.0).astype(np.float32)
    dem = np.tile(np.linspace(5, 1, 36), (36, 1))  # lower to the east
    outs = [{"lon": _ll(1, 5)[0], "lat": _ll(1, 5)[1], "receiving": "Bay", "gated": True, "invert_m": 0.0},
            {"lon": _ll(1, 6)[0], "lat": _ll(1, 6)[1], "receiving": "Bay", "gated": True, "invert_m": 0.0},
            {"lon": _ll(1, 30)[0], "lat": _ll(1, 30)[1], "receiving": "Creek", "gated": False, "invert_m": -1.0}]
    place = {"name": "Eastside", "ring": [_ll(0, 18), _ll(0, 36), _ll(36, 36), _ll(36, 18)]}
    zid, recs = D.zones(GRID, land, inlets, dem, outs, [place], min_inlets=20)
    assert (zid[land] >= 0).all() and (zid[~land] == -1).all()
    assert {r["receiving"] for r in recs} == {"Bay", "Creek"}  # the 2nd Bay outfall is thinned away
    assert len(recs) >= 3  # the catchments are cut into 600 m tiles
    side = 600.0 * 1.25
    assert all(r["area_m2"] <= side * side for r in recs)
    names = [r["name"] for r in recs]
    assert len(set(names)) == len(names) and any(n.startswith("Eastside") for n in names)
    for r in recs:
        cells = np.flatnonzero(zid.reshape(-1) == r["id"])
        assert r["inlets"] == pytest.approx(len(cells))
        low = dem.reshape(-1)[r["surcharge_cells"]]
        assert low.max() <= np.quantile(dem.reshape(-1)[cells], 0.1) + 1e-9


def test_region_polygons_hole_and_pinch():
    ring = np.zeros((36, 36), bool)
    ring[5:8, 5:8] = True
    ring[6, 6] = False
    polys = D.region_polygons(GRID, ring)
    assert len(polys) == 1 and len(polys[0]) == 2  # outer + hole
    diag = np.zeros((36, 36), bool)
    diag[1, 1] = diag[2, 2] = True
    assert len(D.region_polygons(GRID, diag)) == 2


def test_network_doc_and_geojson_ids_match_features():
    net = D.network(GRID, [{"channel": "covered", "coords": [_ll(20, 10), _ll(2, 10)], "osm_id": "9", "name": None}],
                    _water_north(), [{"cells": [[25, c] for c in range(5, 16)]}])
    land = ~_water_north()
    zid, recs = D.zones(GRID, land, land.astype(np.float32), np.ones((36, 36)),
                        [{"lon": _ll(1, 5)[0], "lat": _ll(1, 5)[1], "receiving": "Bay", "gated": True,
                          "invert_m": 0.0}], min_inlets=1)
    doc = D.network_doc(GRID, net, zid, recs, "Bay", False, 1e6)
    n = len(doc["nodes"]["cell"])
    assert all(len(v) == n for v in doc["nodes"].values())
    cov = [k for k, ch in enumerate(doc["nodes"]["channel"]) if ch == "covered"]
    assert all(doc["nodes"]["weir_m"][k] == 0 and doc["nodes"]["inlets"][k] > 0 for k in cov)
    gj = D.drains_geojson(GRID, net, zid, recs, 38.1, None, "Bay", False)
    kinds = {f["properties"]["kind"] for f in gj["features"]}
    assert {"covered_drain", "gutter_inferred", "sewer_zone", "outfall"} <= kinds
    gids = {f["properties"]["id"] for f in gj["features"]}
    assert {f["id"] for f in doc["features"]} <= gids and "zone:0" in gids


def test_contract_drainage_models():
    with pytest.raises(ValueError):
        Drainage(capacity_mm_h=30, return_period_yr=5)
    DrainageDefault(**{k: v for k, v in D.PROFILES["nyc-queens"].items()})
    spec = ScenarioSpec(aoi_id="x", storm=Storm(total_mm=50, duration_h=1))
    assert spec.drainage is None
