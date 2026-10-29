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
    np.testing.assert_array_equal(coded['test road']['road_mask'], mask)
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


def test_severity_and_p90():
    depth = np.array([[0, 0.15, 0.30], [0.50, 0.80, 9]])
    land = np.array([[True, True, True], [True, True, False]])
    values = [depth[0], depth[1, :2]]
    null = [[np.array([0, 0.1])], [np.array([0.3, 0.5])], [np.array([0.5, 0.8])]]
    fractions, p90s, result = hs._statistics(values, null, depth[land], hs.DEPTH_LEVELS_M)
    assert fractions == [{'0.15': 2 / 3, '0.3': 1 / 3, '0.5': 0},
                         {'0.15': 1, '0.3': 1, '0.5': 1}]
    assert p90s == pytest.approx([0.27, 0.77])
    for level, base in [('0.15', 4 / 5), ('0.3', 3 / 5), ('0.5', 2 / 5)]:
        summary = result['severity'][level]
        assert summary['base_rate'] == base
        assert summary['lift'] == pytest.approx(np.mean([v[level] for v in fractions]) / base)
    assert result['severity']['0.5']['hit_rate'] == 0.5
    assert result['mean_hotspot_p90_depth_m'] == pytest.approx(0.52)
    assert result['p90_percentile'] == pytest.approx(200 / 3)
    assert hs._percentile(0.5, [0, 0.5, 1]) == pytest.approx(100 / 3)
    assert hs._statistics(values, null, depth[land], hs.DEPTH_LEVELS_M)[2] == result


def test_road_null():
    pool = np.array([2, 7, 11, 19])
    samples = hs._road_samples(pool, [2, 3])
    assert len(samples) == hs.NULL_SAMPLES
    again = hs._road_samples(pool, [2, 3])
    for sample, repeat in zip(samples, again):
        for indices, repeated, count in zip(sample, repeat, [2, 3]):
            assert len(indices) == len(np.unique(indices)) == count
            assert np.isin(indices, pool).all()
            np.testing.assert_array_equal(indices, repeated)
    assert hs._road_samples(np.array([], int), [2]) == []


def test_score_land_and_roads(monkeypatch):
    from types import SimpleNamespace

    from dryrun.sim import exposure

    depth = np.array([[0.15, 0.30, 0.50], [0, 8, 9]])
    exclude = np.array([[0, 0, 0], [0, 1, 0]])
    boundary = np.array([[0, 0, 0], [0, 0, 1]])
    monkeypatch.setattr(storage, 'load_aoi', lambda *args: SimpleNamespace(grid=None))
    monkeypatch.setattr(storage, 'load_depth', lambda *args: depth)
    monkeypatch.setattr(storage, 'load_run', lambda *args: SimpleNamespace(scenario=SimpleNamespace(aoi_id='test')))
    monkeypatch.setattr(storage, 'load_raster', lambda _, layer: exclude if layer == 'exclude_mask' else boundary)
    monkeypatch.setattr(hs, '_grid', lambda _: np.meshgrid(np.arange(3), np.arange(2)))
    monkeypatch.setattr(hs, '_disc', lambda *args: np.ones(depth.shape, bool))
    monkeypatch.setattr(exposure, 'edge_arrays', lambda _: SimpleNamespace(flat=np.array([0, 0, 2, 4, 5])))
    coded = hs.Geocoded()
    road = np.array([[True, False, True], [False, False, False]])
    coded['road'] = dict(mask=np.ones(depth.shape, bool), road_mask=road, kind='road', cells=6, how='test', matched='road')
    result = hs.score('test', coded)
    assert result['severity']['0.15']['base_rate'] == 3 / 4
    assert result['severity']['0.3']['base_rate'] == 2 / 4
    assert result['severity']['0.5']['base_rate'] == 1 / 4
    assert result['hotspots']['road']['severity_cells'] == 4
    assert result['hotspots']['road']['p90_depth_m'] == pytest.approx(0.44)
    assert result['road']['hotspots']['road']['cells'] == 2
    assert result['road']['severity']['0.3']['base_rate'] == 0.5
    assert result['road']['p90_percentile'] == 0  # Equal two-cell samples tie the observation.
