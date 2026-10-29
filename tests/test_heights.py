import copy
import json
import sys

import numpy as np
import pytest

from dryrun import storage
from dryrun.pipeline import heights


def collection():
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": f"feature-{i}", "properties": {"id": i, "height_m": 6},
         "geometry": {"type": "Polygon", "coordinates": [[[3, 6], [4, 6], [4, 7], [3, 6]]]}}
        for i in range(5)]}


def test_apply_heights():
    source = collection()
    before = copy.deepcopy(source)
    result, report = heights.apply_heights(source, {0: 1.2, 1: 200, 2: 12.34, 3: float("nan")})
    assert source == before
    assert [f["id"] for f in result["features"]] == [f["id"] for f in source["features"]]
    assert [f["properties"]["id"] for f in result["features"]] == list(range(5))
    assert [f["properties"]["height_m"] for f in result["features"]] == [2.5, 150, 12.3, 6, 6]
    assert [f["properties"]["height_source"] for f in result["features"]] == [
        "2.5D", "2.5D", "2.5D", "assumed", "assumed"]
    assert report == {"total": 5, "with_2_5d": 3, "assumed": 2, "share_2_5d": 0.6,
                      "height_percentiles_m": {"p0": 2.5, "p25": 6, "p50": 6, "p75": 12.3, "p100": 150}}
    empty, stats = heights.apply_heights({"features": []}, {})
    assert empty == {"features": []}
    assert stats["share_2_5d"] == 0
    assert all(v is None for v in stats["height_percentiles_m"].values())


@pytest.fixture
def raster(tmp_path):
    rio = pytest.importorskip("rasterio")
    from rasterio.io import MemoryFile
    from rasterio.transform import from_origin
    from rasterio.warp import transform

    data = np.ones((3, 8, 12), dtype="float32")
    data[1] = 90
    data[1, :4, :4] = np.array([[2, 4, 6, 8], [10, 12, 14, 16],
                              [18, 20, 22, 24], [-9999, 0, -1, np.nan]])
    data[1, 4:, 8:] = 30
    data[0, 0, 0] = 0
    path = tmp_path / "tile.tif"
    with MemoryFile() as mem:
        with mem.open(driver="GTiff", width=12, height=8, count=3, dtype="float32", crs="EPSG:32631",
                      transform=from_origin(550000, 720000, 1, 1), nodata=-9999) as dst:
            dst.write(data)
            for i, name in enumerate(("building_presence", "BUILDING_HEIGHT", "building_fractional_count"), 1):
                dst.set_band_description(i, name)
        storage.write_local_file(path, mem.read())

    def footprint(ident, left, top, right, bottom):
        x = [550000 + left, 550000 + right, 550000 + right, 550000 + left, 550000 + left]
        y = [720000 - top, 720000 - top, 720000 - bottom, 720000 - bottom, 720000 - top]
        lon, lat = transform("EPSG:32631", "EPSG:4326", x, y)
        return {"id": ident, "ring": list(zip(lon, lat))}

    return rio, path, [footprint("a", 0, 0, 4, 4), footprint("b", 8, 4, 12, 8),
                       footprint("outside", 20, 20, 24, 24)]


def test_footprint_heights(raster, monkeypatch):
    _, path, footprints = raster
    monkeypatch.setattr(heights, "MAX_WINDOW", 2)
    assert heights.footprint_heights(iter(footprints), [path], height_band=1) == {"a": 13, "b": 30}
    assert heights.footprint_heights(footprints, [path], presence_min=0.5) == {"a": 14, "b": 30}


def test_band_fallback_and_error(raster):
    rio, path, footprints = raster
    with rio.open(path, "r+") as dst:
        dst.set_band_description(2, "unknown")
    with pytest.raises(ValueError, match="descriptions=.*unknown"):
        heights.footprint_heights(footprints, [path])
    assert heights.footprint_heights(footprints, [path], height_band=2) == {"a": 13, "b": 30}
    with pytest.raises(ValueError, match="explicit index=4"):
        heights.footprint_heights(footprints, [path], height_band=4)


def test_cli_limit(tmp_path, monkeypatch, capsys):
    source, output = tmp_path / "in.geojson", tmp_path / "out.geojson"
    storage.write_local_file(source, storage.dumps(collection()))
    seen = []

    def sample(footprints, tiles, band):
        seen.extend(footprints)
        assert tiles == ["offline.tif"]
        assert band == 2
        return {0: 10}

    monkeypatch.setattr(heights, "footprint_heights", sample)
    monkeypatch.setattr(sys, "argv", ["heights", "--buildings-geojson", str(source), "--tiles", "offline.tif",
                                      "--out", str(output), "--limit", "1", "--height-band", "2"])
    heights.main()
    assert [f["id"] for f in seen] == [0]
    result = json.loads(storage.read_local_file(output))
    assert len(result["features"]) == 5
    assert result["features"][0]["properties"]["height_m"] == 10
    assert json.loads(capsys.readouterr().out)["with_2_5d"] == 1


def test_polygon_mask_and_empty_pixels(raster):
    _, path, _ = raster
    from rasterio.warp import transform

    def ring(points):
        x, y = zip(*points)
        lon, lat = transform("EPSG:32631", "EPSG:4326", x, y)
        return list(zip(lon, lat))

    triangle = ring([(550000.1, 719999.9), (550003.7, 719999.9),
                     (550000.1, 719996.3), (550000.1, 719999.9)])
    empty = ring([(550000, 719997), (550004, 719997), (550004, 719996),
                  (550000, 719996), (550000, 719997)])
    assert heights.footprint_heights([{"id": "triangle", "ring": triangle}, {"id": "empty", "ring": empty}],
                                     [path]) == {"triangle": 8}
