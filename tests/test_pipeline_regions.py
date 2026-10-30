"""Offline regional inputs and unchanged serving contracts."""

import gzip
import hashlib
import io
import json
import sys
from types import SimpleNamespace

import numpy as np
import pytest

from dryrun import storage
from dryrun.pipeline import build_layers, ee_export, osm


def test_worldpop_countries():
    old = ("https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/"
           "2025/NGA/v1/100m/constrained/nga_pop_2025_CN_100m_R2025A_v1.tif")
    assert ee_export.WORLDPOP_URL == old
    assert ee_export.source_urls("population", (0, 0, 1, 1)) == [old]
    assert ee_export.source_urls("population", (0, 0, 1, 1), "NGA") == [old]
    assert ee_export.source_urls("population", (0, 0, 1, 1), "USA") == [
        old.replace("NGA", "USA").replace("nga", "usa")]


def polygon(x, y, size):
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]


@pytest.fixture
def ms_inputs(tmp_path):
    grid, _ = ee_export.grid_for_bbox((-99.01, 30, -99, 30.01))
    ring = polygon(-99.009, 30.001, .0001)
    features = [
        {"type": "Polygon", "coordinates": [ring]},
        {"type": "MultiPolygon", "coordinates": [[polygon(-99.008, 30.002, .00001)],
                                                  [polygon(-99.007, 30.003, .0002)]]},
        {"type": "Polygon", "coordinates": [polygon(-99.006, 30.004, .0001)]},
        {"type": "Polygon", "coordinates": [polygon(-99.005, 30.005, .000001)]},
        {"type": "Polygon", "coordinates": [ring]},
    ]
    rows = [{"type": "Feature", "geometry": geom,
             "properties": {"height": 12 if i == 0 else -1, "confidence": -1}}
            for i, geom in enumerate(features)]
    path = tmp_path / "ms.gz"
    storage.write_local_file(path, gzip.compress("\n".join(json.dumps(row) for row in rows).encode()))
    return grid, path


def test_ms_reader(ms_inputs):
    grid, path = ms_inputs
    records = list(osm._read_ms_buildings(grid, [path]))
    assert len(records) == 4
    first, multi, unknown, duplicate = records
    assert first["lon"] == pytest.approx(-99.00895)
    assert first["lat"] == pytest.approx(30.00105)
    expected_area = .0001 ** 2 * osm.M_PER_DEG_LAT * osm._m_per_deg_lon(first["lat"])
    assert first["area_m2"] == pytest.approx(expected_area)
    assert multi["area_m2"] > first["area_m2"] * 3.9
    assert multi["lon"] == pytest.approx(-99.0069)
    digest = hashlib.sha1(b"-99.008950,30.001050").hexdigest()[:12]
    assert first["id"] == duplicate["id"] == "ms-" + digest
    assert list(osm._read_ms_buildings(grid, [path])) == records
    assert first["height_m"] == 12
    assert "height_m" not in unknown
    index, geo = osm.buildings_layers(grid, records)
    assert len(set(index["ids"])) == 4
    assert first["id"] + "-2" in index["ids"]
    assert sorted(f["properties"]["height_m"] for f in geo["features"]) == [6.0, 6.0, 6.0, 12]


def test_custom_keywords():
    assert osm.match_keyword("  KERR-ville ", ["Kerr Ville"]) == "Kerr Ville"
    assert osm.match_keyword("Center Point", ["Centre Point"], {"Center Point": "Centre Point"}) == "Centre Point"
    assert osm.match_keyword("Lekki Phase I", ["Lekki Phase 1"]) == "Lekki Phase 1"
    assert osm.match_keyword("Lekki Phase I", ["Other"], {"Lekki Phase I": "Other"}) == "Other"
    assert osm.match_keyword("Lagos", ["Kerrville"]) is None


@pytest.mark.parametrize("debug", [False, True])
def test_regional_build(tmp_path, monkeypatch, debug):
    monkeypatch.setattr(storage, "MODE", "local")
    monkeypatch.setattr(storage, "LOCAL_DATA", tmp_path / "serving")
    grid, _ = ee_export.grid_for_bbox((-99.01, 30, -99.009, 30.001))
    raw = tmp_path / "raw"
    storage.write_local_file(raw / "grid.json", grid.model_dump_json().encode())
    arrays = {"dem": np.full((grid.ny, grid.nx), 10, np.float32),
              "worldcover": np.full((grid.ny, grid.nx), 50, np.uint8),
              "jrc_occurrence": np.full((grid.ny, grid.nx), 255, np.uint8),
              "population": np.ones((grid.ny, grid.nx), np.float32)}
    for key, arr in arrays.items():
        buf = io.BytesIO()
        np.save(buf, arr)
        storage.write_local_file(raw / f"{key}.npy", buf.getvalue())
    coords = [(-99.0099, 30.0005), (-99.0091, 30.0005)]
    geom = SimpleNamespace(geom_type="LineString", coords=coords)
    feature = SimpleNamespace(geometry=geom, get=lambda key: "river")
    features = SimpleNamespace(iterrows=lambda: iter([(("way", 1), feature)]))
    monkeypatch.setitem(sys.modules, "osmnx", SimpleNamespace(features_from_xml=lambda *a, **kw: features))
    manifest = build_layers.build("texas", str(raw), full=False, debug_layers=debug,
                                  osm_files={"features": "offline.xml"} if debug else None)
    assert set(manifest.layers) == {
        "dem", "manning", "infiltration_mm_h", "drain_sink_mm_h", "boundary_mask", "exclude_mask", "population",
        "roads_graph", "shelters", "places", "buildings", "buildings_geojson"}
    assert set(manifest.sources) == set(manifest.layers)
    for key in ("jrc_occurrence", "river_mask"):
        path = storage.LOCAL_DATA / "texas" / f"{key}.npy"
        assert path.exists() == debug
        if debug:
            arr = np.load(io.BytesIO(storage.read_local_file(path)), allow_pickle=False)
            if key == "jrc_occurrence":
                np.testing.assert_array_equal(arr, arrays[key])
                assert arr.dtype == np.uint8
            else:
                expected = np.zeros((grid.ny, grid.nx), bool)
                for r, c in osm.line_cells(grid, coords):
                    expected[r, c] = True
                np.testing.assert_array_equal(arr, expected)
    storage.clear_caches()


def test_ms_build_source_and_places(ms_inputs, monkeypatch):
    import networkx as nx

    grid, path = ms_inputs
    written = {}
    monkeypatch.setattr(storage, "write_aoi_file", lambda aoi, name, data, *a: written.update({name: data}))
    monkeypatch.setattr(osm, "_fetch_roads", lambda *a: nx.Graph())
    monkeypatch.setattr(osm, "_fetch_shelter_candidates", lambda *a: [])
    keywords, aliases = ["Kerrville"], {"Kerr Ville": "Kerrville"}

    def places(actual_grid, actual_keywords, xml, actual_aliases, place_tags=None, corridor_tags=None):
        assert actual_grid == grid and actual_keywords == keywords and actual_aliases == aliases
        return []

    monkeypatch.setattr(osm, "_fetch_place_candidates", places)
    shape = (grid.ny, grid.nx)
    layers, sources, report = osm.build("ms", grid, np.zeros(shape), np.zeros(shape, bool), [path],
                                       building_source="ms", keywords=keywords, place_aliases=aliases)
    assert sources["buildings"] == sources["buildings_geojson"] == "Microsoft Global ML Building Footprints, ODbL"
    assert len(json.loads(written[layers["buildings"]])["ids"]) == 4
    assert report["keywords_missing"] == keywords


def test_coarse_grid():
    bbox = (3.47001, 6.42001, 3.48001, 6.43001)
    native, _ = ee_export.grid_for_bbox(bbox)
    grid, transform = ee_export.grid_for_bbox(bbox, step_arcsec=2)
    assert (grid.nx, grid.ny) == (19, 19)
    assert grid.bounds_wgs84 == (12492 / 3600, 23112 / 3600, 12530 / 3600, 23150 / 3600)
    assert transform == (2 / 3600, 0, 12492 / 3600, 0, -2 / 3600, 23150 / 3600)
    assert grid.dx_m == 2 * native.dx_m
    assert grid.dy_m == 2 * native.dy_m
    assert grid.cell_size_m == 2 * native.cell_size_m
    negative, _ = ee_export.grid_for_bbox((-3.1 / 3600, -3.1 / 3600, -.1 / 3600, -.1 / 3600), 2)
    assert negative.bounds_wgs84 == (-4 / 3600, -4 / 3600, 0, 0)
    assert (negative.nx, negative.ny) == (2, 2)


@pytest.mark.parametrize("step", [0, -1, 1.5, True])
def test_invalid_grid_step(step):
    with pytest.raises(ValueError, match="positive integer"):
        ee_export.grid_for_bbox((0, 0, 1, 1), step)


@pytest.fixture
def regional_raster(tmp_path):
    pytest.importorskip("rasterio")
    from affine import Affine
    from rasterio.io import MemoryFile

    def write(data, nodata=None):
        path = tmp_path / "source.tif"
        with MemoryFile() as mem:
            with mem.open(driver="GTiff", count=1, width=data.shape[1], height=data.shape[0], dtype=data.dtype,
                          crs="EPSG:4326", transform=Affine(ee_export.STEP, 0, 0, 0, -ee_export.STEP,
                                                          data.shape[0] * ee_export.STEP), nodata=nodata) as dst:
                dst.write(data, 1)
            storage.write_local_file(path, mem.read())
        return str(path)

    return write


def test_coarse_dem_and_jrc(regional_raster):
    grid, transform = ee_export.grid_for_bbox((0, 0, 2 / 3600, 2 / 3600), 2)
    assert (grid.nx, grid.ny) == (1, 1)
    dem = regional_raster(np.array([[2, 4], [6, 12]], np.float32))
    np.testing.assert_array_equal(ee_export.resample_dem(dem, grid, transform), [[6]])
    jrc = regional_raster(np.array([[100, 255], [80, 90]], np.uint8), nodata=255)
    np.testing.assert_array_equal(ee_export.resample_jrc(jrc, grid, transform), [[90]])
    jrc = regional_raster(np.full((2, 2), 255, np.uint8), nodata=255)
    np.testing.assert_array_equal(ee_export.resample_jrc(jrc, grid, transform), [[255]])


def test_coarse_population(regional_raster):
    grid, transform = ee_export.grid_for_bbox((0, 0, 4 / 3600, 4 / 3600), 2)
    data = np.arange(1, 17, dtype=np.float32).reshape(4, 4)
    data[0, 0] = -9999
    path = regional_raster(data, nodata=-9999)
    result = ee_export.resample_population(path, grid, transform)
    expected = np.where(data == -9999, 0, data).reshape(2, 2, 2, 2).sum(axis=(1, 3))
    np.testing.assert_array_equal(result, expected)
    assert result.sum() == data[data != -9999].sum()


@pytest.mark.parametrize("step", [1, 2])
def test_download_grid_step(regional_raster, tmp_path, monkeypatch, step):
    source = regional_raster(np.full((4, 4), 10, np.float32))
    monkeypatch.setattr(ee_export, "source_urls", lambda *a: [source])
    out = tmp_path / "raw"
    ee_export.download("grid-step", (0, 0, 4 / 3600, 4 / 3600), str(out), step_arcsec=step)
    metadata = json.loads(storage.read_local_file(out / "grid.json"))
    assert metadata.get("step_arcsec", 1) == step
    assert metadata["nx"] == metadata["ny"] == 4 // step
    assert metadata["transform"][0] == step / 3600
    monkeypatch.setattr(storage, "MODE", "local")
    monkeypatch.setattr(storage, "LOCAL_DATA", tmp_path / "serving")
    manifest = build_layers.build("coarse", str(out))
    assert manifest.grid.nx == manifest.grid.ny == 4 // step
    assert manifest.grid.dx_m == metadata["dx_m"]
    storage.clear_caches()


def test_coarse_osm_helpers():
    grid, _ = ee_export.grid_for_bbox((0, 0, 8 / 3600, 8 / 3600), 2)
    a, b = (1 / 3600, 7 / 3600), (7 / 3600, 7 / 3600)
    assert tuple(map(int, osm.cell_of(grid, *a))) == (0, 0)
    assert osm.line_cells(grid, [a, b]) == [[0, c] for c in range(4)]
    record = {"id": "coarse", "lon": b[0], "lat": b[1], "area_m2": 50, "confidence": 1,
              "ring": polygon(b[0], b[1], .00001)}
    index, _ = osm.buildings_layers(grid, [record])
    assert index == {"ids": ["coarse"], "row": [0], "col": [3]}
    places = osm.point_places(grid, {"All": (4 / 3600, 4 / 3600)})
    assert set(places) == {"All"}
    np.testing.assert_allclose(places["All"], [
        (1 / 3600, 1 / 3600), (7 / 3600, 1 / 3600), (7 / 3600, 7 / 3600),
        (1 / 3600, 7 / 3600), (1 / 3600, 1 / 3600)])


def test_nyc_footprints_reader(tmp_path):
    grid, _ = ee_export.grid_for_bbox((-73.91, 40.72, -73.90, 40.73))
    sq = lambda x, y, d=2e-4: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]]  # noqa: E731
    feats = [
        {"type": "Feature", "properties": {"doitt_id": "1", "feature_code": "2100", "height_roof": "33.0"},
         "geometry": {"type": "MultiPolygon", "coordinates": [sq(-73.905, 40.725)]}},
        {"type": "Feature", "properties": {"doitt_id": "2", "feature_code": "5110", "height_roof": "0"},
         "geometry": {"type": "Polygon", "coordinates": sq(-73.904, 40.725)}},
        {"type": "Feature", "properties": {"doitt_id": "3", "feature_code": "1001", "height_roof": "15"},  # canopy
         "geometry": {"type": "Polygon", "coordinates": sq(-73.903, 40.725)}},
        {"type": "Feature", "properties": {"doitt_id": "4", "feature_code": "2100", "height_roof": "20"},  # outside
         "geometry": {"type": "Polygon", "coordinates": sq(-73.80, 40.725)}},
    ]
    path = tmp_path / "nyc.geojson"
    storage.write_local_file(path, json.dumps({"type": "FeatureCollection", "features": feats}).encode())
    recs = list(osm.building_reader("nyc_footprints")(grid, [str(path)]))
    assert [r["id"] for r in recs] == ["nyc-1", "nyc-2"]
    assert recs[0]["height_m"] == round(33 * 0.3048, 2) and "height_m" not in recs[1]
    index, geo = osm.buildings_layers(grid, recs)
    assert index["ids"] == ["nyc-1", "nyc-2"]
    assert geo["features"][1]["properties"]["height_m"] == osm.DEFAULT_HEIGHT_M
