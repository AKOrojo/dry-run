import importlib.util
import io
from pathlib import Path

import numpy as np
import pytest

from dryrun import storage
from dryrun.contracts import RunManifest, ScenarioSpec, Storm
from dryrun.pipeline import fixtures

# evals/ is not a package: load the script by path, as tests/test_surrogate.py does for csi.py.
_p = Path(__file__).resolve().parents[1] / "evals" / "validation" / "hotspots.py"
_spec = importlib.util.spec_from_file_location("hotspots", _p)
hs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hs)


@pytest.fixture
def aoi(tmp_path, monkeypatch):
    monkeypatch.setenv('DRYRUN_STORAGE', 'local')
    monkeypatch.setattr(storage, 'LOCAL_DATA', tmp_path / 'data')
    monkeypatch.setattr(storage, 'LOCAL_RUNS', tmp_path / 'runs')
    storage.clear_caches()
    result = fixtures.build()
    yield result
    storage.clear_caches()


def test_geocode(aoi, tmp_path):
    def node(i, r, c, tags=''):
        lon, lat = fixtures.cell_to_lonlat(r, c)
        return f'<node id="{i}" lon="{lon}" lat="{lat}">{tags}</node>'

    road = tmp_path / 'roads.osm'
    features = tmp_path / 'features.osm'
    storage.write_local_file(road, ('<osm>' + node(1, 20, 20) + node(2, 20, 25)
                                  + '<way><nd ref="1"/><nd ref="2"/><tag k="name" v="Test-Road"/></way>'
                                  + '</osm>').encode())
    storage.write_local_file(features, ('<osm>' + node(3, 60, 60,
                             '<tag k="name" v="Village"/><tag k="place" v="suburb"/>') + '</osm>').encode())
    names = [dict(name='North Estate (synthetic)', kind='place'), dict(name='test road', kind='road'),
             dict(name='Village', kind='place'), dict(name='Missing', kind='place'),
             dict(name='Canal Corridor (synthetic)', kind='place')]
    coded = hs.geocode(names, aoi.aoi_id, features, road)
    assert coded.unmatched == ['Missing']
    assert coded[names[0]['name']]['how'] == 'places_polygon'
    assert coded[names[0]['name']]['mask'][10, 10]
    mask = coded['test road']['mask']
    assert mask[19:22, 19:27].all()
    assert mask.sum() == 24
    disc = coded['Village']['mask']
    assert disc[60, 65] and not disc[60, 49]
    assert coded['Village']['how'] == 'osm_node_disc'
    exclude = storage.load_raster(aoi.aoi_id, 'exclude_mask') > 0.5
    for value in coded.values():
        assert not (value['mask'] & exclude).any()
        assert value['cells'] == value['mask'].sum()


def test_score(aoi):
    spec = ScenarioSpec(aoi_id=aoi.aoi_id, storm=Storm(total_mm=50, duration_h=3))
    run_id = spec.run_id()
    storage.save_run(RunManifest(run_id=run_id, scenario=spec, status='done'))
    depth = np.zeros((aoi.grid.ny, aoi.grid.nx))
    depth[10, 10:12] = 0.15
    buf = io.BytesIO()
    np.save(buf, depth)
    storage.write_run_file(run_id, 'max_depth.npy', buf.getvalue(), 'application/octet-stream')
    coded = hs.Geocoded()
    for name, row, weak in [('wet', 10, False), ('dry', 11, True)]:
        mask = np.zeros(depth.shape, bool)
        mask[row, 10:14] = True
        coded[name] = dict(mask=mask, matched=name, how='test', cells=4, weak=weak)
    result = hs.score(run_id, coded)
    land = (storage.load_raster(aoi.aoi_id, 'exclude_mask') <= 0.5)
    land &= storage.load_raster(aoi.aoi_id, 'boundary_mask') <= 0.5
    assert result['hit_rate'] == 0.5
    assert result['weak_excluded_hit_rate'] == 1
    assert result['base_rate'] == 2 / land.sum()
    assert result['lift'] == 0.25 / result['base_rate']
    assert result['random_disc_percentile'] == hs.score(run_id, coded)['random_disc_percentile']
    assert result['random_disc_percentile'] == 100
