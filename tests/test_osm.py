"""Eng D's OSM / buildings / places rules in pipeline/osm.py (pure numpy + networkx, no network)."""

import io
import json

import networkx as nx
import numpy as np

from dryrun.contracts import GridSpec
from dryrun.pipeline import osm

W, S, E, N = 3.47, 6.42, 3.48, 6.43  # 36 x 36 one-arc-second cells
GRID = GridSpec(cell_size_m=30.6, dx_m=30.7, dy_m=30.5, nx=36, ny=36, bounds_wgs84=(W, S, E, N))
D = 1 / 3600


def _ll(r, c):  # centre of cell (r, c)
    return W + (c + 0.5) * D, N - (r + 0.5) * D


def test_lonlat_to_cell_corners():
    assert [int(v) for v in osm.cell_of(GRID, *_ll(0, 0))] == [0, 0]
    assert [int(v) for v in osm.cell_of(GRID, *_ll(35, 35))] == [35, 35]
    assert not osm.in_grid(GRID, W - D, N - D) and osm.in_grid(GRID, *_ll(10, 20))


def test_line_cells_are_contiguous_and_never_shorter_than_two():
    cells = osm.line_cells(GRID, [_ll(2, 2), _ll(2, 12), _ll(20, 12)])
    assert cells[0] == [2, 2] and cells[-1] == [20, 12]
    steps = np.abs(np.diff(np.array(cells), axis=0)).max(1)
    assert (steps <= 1).all()  # sampled every <= 1 cell
    assert osm.line_cells(GRID, [_ll(5, 5), _ll(5, 5)]) == [[5, 5], [5, 5]]


def _toy_roads():
    nodes = {1: _ll(4, 4), 2: _ll(4, 20), 3: _ll(20, 20), 4: _ll(30, 30), 5: _ll(31, 31)}
    edges = [
        {"u": 1, "v": 2, "length_m": 500.0, "drive": False, "bridge": False},
        {"u": 2, "v": 1, "length_m": 490.0, "drive": False, "bridge": False},  # parallel, shorter
        {"u": 1, "v": 2, "length_m": 520.0, "drive": True, "bridge": False},   # parallel, drivable
        {"u": 2, "v": 3, "length_m": 500.0, "drive": True, "bridge": True, "coords": [_ll(4, 20), _ll(20, 20)]},
        {"u": 3, "v": 3, "length_m": 10.0, "drive": True, "bridge": False},    # self-loop
        {"u": 4, "v": 5, "length_m": 40.0, "drive": True, "bridge": False},    # island
    ]
    return nodes, edges


def test_simple_road_graph_meets_the_contract():
    g = osm.simple_road_graph(GRID, *_toy_roads())
    assert not g.is_multigraph() and not g.is_directed()
    assert set(g.nodes) == {"1", "2", "3"}  # island dropped, self-loop dropped
    e = g.edges["1", "2"]
    assert e["length_m"] == 490.0 and e["drive"] == 1  # shortest kept, drive if any parallel is
    assert g.edges["2", "3"]["bridge"] == 1
    assert g.nodes["3"]["row"] == 20 and g.nodes["3"]["col"] == 20
    # round-trips through GraphML into exactly what exposure.road_graph expects
    g2 = nx.read_graphml(io.BytesIO(osm.graphml_bytes(g)))
    for _, _, d in g2.edges(data=True):
        assert len(json.loads(d["cells"])) >= 2 and float(d["length_m"]) > 0


def test_empty_layers_are_valid():
    out = osm.empty_layers()
    g = nx.read_graphml(io.BytesIO(out["roads.graphml"]))
    assert g.number_of_edges() == 0 and not g.is_directed()
    assert json.loads(out["shelters.geojson"])["features"] == []


def test_buildings_filter_cap_and_matching_ids():
    ring = [[W, N], [W + D, N], [W + D, N - D], [W, N]]
    recs = [{"id": f"x{i}", "lon": _ll(i, i)[0], "lat": _ll(i, i)[1], "area_m2": 30.0 + i,
             "confidence": 0.9, "ring": ring} for i in range(10)]
    recs += [{"id": "lowconf", "lon": _ll(1, 1)[0], "lat": _ll(1, 1)[1], "area_m2": 99, "confidence": 0.5, "ring": ring},
             {"id": "tiny", "lon": _ll(1, 1)[0], "lat": _ll(1, 1)[1], "area_m2": 10, "confidence": 0.95, "ring": ring},
             {"id": "outside", "lon": E + D, "lat": N - D, "area_m2": 99, "confidence": 0.95, "ring": ring}]
    idx, geo = osm.buildings_layers(GRID, recs, cap=4)
    assert idx["ids"] == ["x6", "x7", "x8", "x9"]  # largest 4 kept, sorted by id
    assert [f["properties"]["id"] for f in geo["features"]] == idx["ids"]
    assert idx["row"] == [6, 7, 8, 9] and idx["col"] == [6, 7, 8, 9]
    assert all(f["properties"]["height_m"] == osm.DEFAULT_HEIGHT_M for f in geo["features"])


def test_shelters_need_high_ground_and_a_nearby_road():
    dem = np.tile(np.linspace(0, 10, 36, dtype=np.float32)[:, None], (1, 36))[::-1].copy()  # high north
    land = np.ones_like(dem, bool)
    g = osm.simple_road_graph(GRID, {1: _ll(1, 1), 2: _ll(1, 10)},
                              [{"u": 1, "v": 2, "length_m": 280.0, "drive": True, "bridge": False}])
    cands = [{"name": "High School", "kind": "school", "lon": _ll(1, 5)[0], "lat": _ll(1, 5)[1]},
             {"name": None, "kind": "place_of_worship", "lon": _ll(2, 3)[0], "lat": _ll(2, 3)[1]},
             {"name": "Low Church", "kind": "place_of_worship", "lon": _ll(34, 5)[0], "lat": _ll(34, 5)[1]},
             {"name": "Far Hall", "kind": "community_centre", "lon": _ll(1, 35)[0], "lat": _ll(1, 35)[1]}]
    fc = osm.pick_shelters(GRID, cands, dem, land, g)
    names = [f["properties"]["name"] for f in fc["features"]]
    assert names == ["High School (candidate shelter (assumed))",
                     "Unnamed place of worship (candidate shelter (assumed))"]
    p = fc["features"][0]["properties"]
    assert (p["row"], p["col"]) == (1, 5) and p["status"] == osm.SHELTER_LABEL


def test_places_are_simple_named_polygons():
    circle = [(np.cos(t), np.sin(t)) for t in np.linspace(0, 2 * np.pi, 80, endpoint=False)]
    ring = osm.simplify_ring(circle)
    assert ring[0] == ring[-1] and len(ring) - 1 <= osm.MAX_PLACE_VERTICES
    fc = osm.places_collection([{"name": "Ajah", "kind": "neighbourhood", "ring": circle},
                                {"name": "Ajah", "kind": "corridor", "ring": circle},
                                {"name": "Field (open land)", "kind": "open_land", "ring": circle}])
    assert [f["properties"]["name"] for f in fc["features"]] == ["Ajah", "Field (open land)"]
    assert all(f["geometry"]["type"] == "Polygon" for f in fc["features"])


def test_point_places_split_the_grid_between_named_points():
    out = osm.point_places(GRID, {"Ikota": _ll(8, 8), "Osapa": _ll(28, 28)}, radius_m=2000)
    assert set(out) == {"Ikota", "Osapa"}

    def inside(pt, ring):  # ray casting
        x, y, hit = *pt, False
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
        return hit

    assert inside(_ll(8, 8), out["Ikota"]) and not inside(_ll(28, 28), out["Ikota"])
    assert inside(_ll(28, 28), out["Osapa"]) and not inside(_ll(8, 8), out["Osapa"])


def test_keyword_matching_is_canonical():
    kw = ["Lekki-Epe Expressway", "Ajah", "Lekki Phase 1"]
    assert osm.match_keyword("lekki epe expressway", kw) == "Lekki-Epe Expressway"
    assert osm.match_keyword("AJAH", kw) == "Ajah"
    assert osm.match_keyword("Ajah Market", kw) is None and osm.match_keyword(None, kw) is None
    assert osm.match_keyword(float("nan"), kw) is None


def test_aliases_and_protected_land():
    from dryrun.meta.media import LAGOS_KEYWORDS

    assert osm.match_keyword("Lekki Phase I", LAGOS_KEYWORDS) == "Lekki Phase 1"
    assert osm.match_keyword("Osapa London", LAGOS_KEYWORDS) == "Osapa"
    assert not osm.usable_open_land("Lekki Conservation Center", "park")
    assert not osm.usable_open_land(None, "nature_reserve") and not osm.usable_open_land("x", None, "protected_area")
    assert osm.usable_open_land(float("nan"), "park") and osm.usable_open_land("Victoria Garden City Recreational Park")


def test_edges_leaving_the_grid_get_no_border_cells():
    out = osm.line_cells(GRID, [_ll(10, 30), (E + 0.01, N - 10.5 * D)])  # runs 36 cells past the east edge
    assert out[0] == [10, 30] and max(c for _, c in out) == 35 and len(out) == 6
    assert osm.line_cells(GRID, [(E + D, N - D), (E + 5 * D, N - D)]) == []
    nodes = {1: _ll(5, 5), 2: _ll(5, 20), 3: (E + 9 * D, N - 5.5 * D), 4: (E + 2 * D, N), 5: (E + 9 * D, N)}
    edges = [{"u": 1, "v": 2, "length_m": 1.0, "drive": True, "bridge": False},
             {"u": 2, "v": 3, "length_m": 1.0, "drive": True, "bridge": False},
             {"u": 4, "v": 5, "length_m": 1.0, "drive": True, "bridge": False}]  # fully outside: dropped
    g = osm.simple_road_graph(GRID, nodes, edges)
    assert set(g.nodes) == {"1", "2", "3"}
    assert all(0 <= c < 36 for c in np.array(json.loads(g.edges["2", "3"]["cells"]))[:, 1])


def test_parallel_bridge_survives_collapse():
    nodes = {1: _ll(4, 4), 2: _ll(4, 20)}
    g = osm.simple_road_graph(GRID, nodes, [{"u": 1, "v": 2, "length_m": 400.0, "drive": True, "bridge": False},
                                            {"u": 1, "v": 2, "length_m": 420.0, "drive": True, "bridge": True}])
    assert g.edges["1", "2"]["bridge"] == 1 and g.edges["1", "2"]["length_m"] == 400.0


def test_duplicate_building_ids_are_suffixed():
    ring = [[W, N], [W + D, N], [W + D, N - D], [W, N]]
    recs = [{"id": "6FR5", "lon": _ll(3, 3)[0], "lat": _ll(3, 3)[1], "area_m2": 40.0 + i, "confidence": 0.9,
             "ring": ring} for i in range(3)]
    idx, geo = osm.buildings_layers(GRID, recs)
    assert idx["ids"] == ["6FR5", "6FR5-2", "6FR5-3"] == [f["properties"]["id"] for f in geo["features"]]


def test_shelters_ignore_nan_dem_and_accept_uint8_masks():
    dem = np.full((36, 36), np.nan, np.float32)
    dem[:5] = 10.0
    g = osm.simple_road_graph(GRID, {1: _ll(1, 1), 2: _ll(1, 10)},
                              [{"u": 1, "v": 2, "length_m": 280.0, "drive": True, "bridge": False}])
    cands = [{"name": "A", "kind": "school", "lon": _ll(1, 5)[0], "lat": _ll(1, 5)[1]},
             {"name": "B", "kind": "school", "lon": _ll(20, 5)[0], "lat": _ll(20, 5)[1]}]  # NaN DEM cell
    fc = osm.pick_shelters(GRID, cands, dem, np.ones((36, 36), np.uint8), g)
    assert [f["properties"]["name"].split(" (")[0] for f in fc["features"]] == ["A"]
