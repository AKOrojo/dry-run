"""Offline Sentinel-1 arithmetic and reprojection checks."""

import io

import numpy as np
import pytest

from dryrun import storage
from dryrun.pipeline import s1_flood as s1
from dryrun.pipeline.ee_export import grid_for_bbox


def test_power_to_db():
    result = s1.power_to_db(np.array([[1, 0.1, 0.01, 0, -1, np.nan, np.inf]]))
    np.testing.assert_allclose(result[0, :3], [0, -10, -20], atol=1e-5)
    assert np.isnan(result[0, 3:]).all()


def test_speckle_nodata_and_edges():
    data = np.full((5, 5), -20, np.float32)
    data[2, 2] = 20
    data[0, 0] = np.nan
    filtered = s1.speckle_filter(data)
    assert np.isnan(filtered[0, 0])
    assert (filtered[np.isfinite(filtered)] == -20).all()
    assert np.isnan(s1.speckle_filter(np.full((2, 2), np.nan))).all()


def test_strict_flood_thresholds_and_validity():
    pre = np.array([[-14, -15, -17, -20, np.nan, -10]], np.float32)
    post = np.array([[-19, -18, -20, -21, -22, np.nan]], np.float32)
    flooded, valid = s1.flood_rule(pre, post)
    np.testing.assert_array_equal(flooded, [[1, 0, 0, 0, 0, 0]])
    np.testing.assert_array_equal(valid, [[1, 1, 1, 1, 0, 0]])
    assert flooded.dtype == np.float32
    with pytest.raises(ValueError):
        s1.flood_rule(pre, post[:, :2])


def test_reprojection_linear_average(tmp_path):
    rasterio = pytest.importorskip("rasterio")
    from rasterio.transform import from_bounds
    from rasterio.warp import transform_bounds

    grid, transform = grid_for_bbox((3.5, 6.45, 3.501, 6.451))
    bounds = transform_bounds(grid.crs, "EPSG:32631", *grid.bounds_wgs84)
    data = np.full((40, 40), 0.01, np.float32)
    data[:, ::2] = 0.09
    path = tmp_path / "power.tif"
    with rasterio.io.MemoryFile() as mem:
        with mem.open(driver="GTiff", width=40, height=40, count=1, dtype="float32",
                      crs="EPSG:32631", transform=from_bounds(*bounds, 40, 40), nodata=0) as dst:
            dst.write(data, 1)
        storage.write_local_file(path, mem.read())
    result = s1._resample(path, grid, transform)
    assert result.shape == (grid.ny, grid.nx)
    np.testing.assert_allclose(result, 0.05, atol=0.005)
    np.testing.assert_allclose(s1.power_to_db(result), 10 * np.log10(0.05), atol=0.5)
    distant, distant_transform = grid_for_bbox((4.5, 6.45, 4.501, 6.451))
    assert np.isnan(s1._resample(path, distant, distant_transform)).all()


def test_export_masks_metadata_and_copies(tmp_path, monkeypatch):
    rasterio = pytest.importorskip("rasterio")
    grid, transform = grid_for_bbox((3.5, 6.45, 3.501, 6.451))
    storage.write_local_file(tmp_path / "grid.json", storage.dumps({**grid.model_dump(), "transform": transform}))
    mask = np.zeros((grid.ny, grid.nx), np.float32)
    mask[0, 0] = 1
    stream = io.BytesIO()
    np.save(stream, mask)
    storage.write_local_file(tmp_path / "mask.npy", stream.getvalue())

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"token": "secret"}

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def get(self, url):
            return Response()

    def select(client, selector, bbox):
        return [{"id": selector, "properties": {"datetime": selector, "sat:relative_orbit": 95,
                                                "sat:orbit_state": "descending"},
                 "assets": {band: {"href": f"https://example.org/{band}?secret"} for band in ("vv", "vh")}}]

    monkeypatch.setattr(s1, "_client", Client)
    monkeypatch.setattr(s1, "_select", select)
    monkeypatch.setattr(s1, "_scene", lambda items, *args: {
        band: np.full(mask.shape, -10 if items[0]["id"] == "pre" else -20, np.float32)
        for band in ("vv", "vh")})
    report = s1.export(tmp_path / "grid.json", "pre", "post", tmp_path / "out",
                       tmp_path / "mask.npy", tmp_path / "mask.npy")
    assert report["flooded_cells"] == mask.size
    assert report["flooded_cells_inside_exclude"] == report["flooded_cells_inside_boundary"] == 1
    assert report["valid_fraction"] == 1
    assert report["flooded_km2"] == pytest.approx(mask.size * grid.dx_m * grid.dy_m / 1e6)
    assert b"secret" not in storage.read_local_file(tmp_path / "out/s1_meta.json")
    for name in ("obs_flood_extent", "pre_vv_db", "post_vv_db", "valid"):
        array = np.load(io.BytesIO(storage.read_local_file(tmp_path / f"out/{name}.npy")))
        with rasterio.io.MemoryFile(storage.read_local_file(tmp_path / f"out/{name}.tif")) as mem:
            with mem.open() as src:
                np.testing.assert_array_equal(array, src.read(1))
                assert src.crs.to_string() == grid.crs


def test_orbit_mismatch_rejected(tmp_path, monkeypatch):
    pytest.importorskip("rasterio")
    grid, transform = grid_for_bbox((3.5, 6.45, 3.501, 6.451))
    storage.write_local_file(tmp_path / "grid.json", storage.dumps({**grid.model_dump(), "transform": transform}))
    from contextlib import nullcontext

    monkeypatch.setattr(s1, "_client", lambda: nullcontext(None))
    monkeypatch.setattr(s1, "_select", lambda client, selector, bbox: [{"properties": {
        "sat:relative_orbit": 95 if selector == "pre" else 96, "sat:orbit_state": "descending"}}])
    with pytest.raises(ValueError, match="must match"):
        s1.export(tmp_path / "grid.json", "pre", "post", tmp_path / "out")


def test_mosaic_averages_overlap_in_linear_power(monkeypatch):
    grid, transform = grid_for_bbox((3.5, 6.45, 3.501, 6.451))
    shape = (grid.ny, grid.nx)
    tiles = {"a": np.full(shape, 0.01, np.float32), "b": np.full(shape, 0.09, np.float32)}
    tiles["a"][0, 0] = np.nan
    tiles["b"][0, 0] = np.nan
    items = [{"assets": {band: {"href": name} for band in ("vv", "vh")}} for name in tiles]
    monkeypatch.setattr(s1, "_resample", lambda path, *args: tiles[path.split("?")[0]])
    result = s1._scene(items, "secret", grid, transform)
    for band in ("vv", "vh"):
        assert np.isnan(result[band][0, 0])
        np.testing.assert_allclose(result[band][1:, :], 10 * np.log10(0.05), atol=1e-5)
