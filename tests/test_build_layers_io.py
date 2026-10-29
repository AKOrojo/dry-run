import json

import numpy as np
import pytest

from dryrun import storage
from dryrun.contracts import AOIManifest, GridSpec
from dryrun.contracts.schemas import REQUIRED_AOI_LAYERS
from dryrun.pipeline.build_layers import build, waterway_cells
from dryrun.pipeline.ee_export import grid_for_bbox
from dryrun.sim import exposure


def test_waterway_cells():
    grid = GridSpec(nx=7, ny=7, cell_size_m=30, dx_m=30, dy_m=30, bounds_wgs84=(0, 0, 7, 7))
    masks = waterway_cells(grid, {"drain": [[(1.5, 3.5), (5.5, 3.5)]]})
    expected = np.zeros((7, 7), bool)
    expected[2:5, :] = True
    np.testing.assert_array_equal(masks["drain"], expected)
    assert set(masks) == {"drain", "ditch", "canal"}
    assert not masks["ditch"].any() and not masks["canal"].any()
    assert all(mask.dtype == bool and not mask.any() for mask in waterway_cells(grid, {}).values())
    edge = waterway_cells(grid, {"canal": [[(0.5, 6.5), (1.5, 6.5)]]})["canal"]
    assert edge[:2, :3].all() and edge.sum() == 6


@pytest.fixture
def raw_inputs(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "MODE", "local")
    monkeypatch.setattr(storage, "LOCAL_DATA", tmp_path / "serving")
    storage.clear_caches()
    grid, transform = grid_for_bbox((3.47, 6.46, 3.472, 6.462))
    raw = tmp_path / "raw"
    raw.mkdir()
    metadata = {**grid.model_dump(mode="json"), "transform": transform,
                "sources": {k: {"credit": f"test {k}", "licence": "test licence"}
                            for k in ("dem", "worldcover", "jrc_occurrence", "population")}}
    (raw / "grid.json").write_text(json.dumps(metadata))
    shape = (grid.ny, grid.nx)
    arrays = {"dem": np.full(shape, 5), "worldcover": np.full(shape, 50),
              "jrc_occurrence": np.zeros(shape), "population": np.full(shape, 2.0)}
    arrays["population"][0, 0] = np.nan
    for key, arr in arrays.items():
        np.save(raw / f"{key}.npy", arr)
    yield raw, grid
    storage.clear_caches()


def test_build_end_to_end(raw_inputs):
    raw, grid = raw_inputs
    manifest = build("tiny", str(raw))
    assert AOIManifest.model_validate_json(manifest.model_dump_json()) == storage.load_aoi("tiny")
    assert set(REQUIRED_AOI_LAYERS) <= manifest.layers.keys()
    assert {"places", "buildings_geojson"} <= manifest.layers.keys()
    assert not manifest.is_synthetic
    for key in ("dem", "manning", "infiltration_mm_h", "drain_sink_mm_h", "boundary_mask",
                "exclude_mask", "population"):
        arr = storage.load_raster("tiny", key)
        assert arr.shape == (grid.ny, grid.nx) and arr.dtype == np.float32
        assert np.isfinite(arr).all()
    assert storage.load_raster("tiny", "population")[0, 0] == 0
    assert exposure.road_graph("tiny").number_of_nodes() == 0
    zeros = np.zeros((grid.ny, grid.nx), np.float32)
    impact = exposure.impact("tiny", zeros, grid.dx_m * grid.dy_m, zeros.astype(bool))
    assert all(value == 0 for key, value in impact.items() if key != "passability_threshold_m")
    with pytest.raises(ValueError, match="AOI ids are immutable; publish a new id"):
        build("tiny", str(raw))


@pytest.mark.parametrize("bad", ["shape", "nan"])
def test_invalid_raw_is_not_published(raw_inputs, bad):
    raw, grid = raw_inputs
    dem = np.zeros((grid.ny, grid.nx), np.float32) if bad == "nan" else np.zeros((1, 1))
    if bad == "nan":
        dem[0, 0] = np.nan
    np.save(raw / "dem.npy", dem)
    with pytest.raises(ValueError):
        build("invalid", str(raw))
    assert not storage._exists("data", "invalid/manifest.json")
