"""Offline grid and raster export checks."""

import math

import numpy as np
import pytest

from dryrun.pipeline import ee_export as ee


def test_grid():
    grid, transform = ee.grid_for_bbox((3.47001, 6.42001, 3.48001, 6.43001))
    assert (grid.nx, grid.ny) == (37, 37)
    assert transform == (1 / 3600, 0, 12492 / 3600, 0, -1 / 3600, 23149 / 3600)
    assert grid.bounds_wgs84 == (12492 / 3600, 23112 / 3600, 12529 / 3600, 23149 / 3600)
    assert grid.dx_m == pytest.approx(111320 / 3600 * math.cos(math.radians(6.42501)))
    assert grid.dy_m == pytest.approx(110574 / 3600)
    assert grid.cell_size_m == pytest.approx(math.sqrt(grid.dx_m * grid.dy_m))


@pytest.mark.parametrize('bbox', [(0, 0, 0, 1), (1, 0, 0, 1), (0, 0, 1, float('nan'))])
def test_invalid_grid(bbox):
    with pytest.raises(ValueError):
        ee.grid_for_bbox(bbox)


def test_negative_and_aligned_grid():
    grid, _ = ee.grid_for_bbox((-1, -1, 0, 0))
    assert (grid.nx, grid.ny) == (3600, 3600)
    assert grid.bounds_wgs84 == (-1, -1, 0, 0)


def test_tile_names():
    bounds = (2.9, 5.9, 3.1, 6.1)
    assert len(ee.source_urls('dem', bounds)) == 4
    assert len(ee.source_urls('worldcover', bounds)) == 4
    assert 'occurrence_0E_10N' in ee.source_urls('jrc_occurrence', bounds)[0]
    assert 'S01_00_W001_00' in ee.source_urls('dem', (-1, -1, 0, 0))[0]


@pytest.fixture
def raster(tmp_path):
    rasterio = pytest.importorskip('rasterio')
    from affine import Affine

    def write(data, step, nodata=None):
        path = tmp_path / 'source.tif'
        with rasterio.open(path, 'w', driver='GTiff', count=1, width=data.shape[1], height=data.shape[0],
                           dtype=data.dtype, crs='EPSG:4326', transform=Affine(step, 0, 0, 0, -step, 4 / 3600),
                           nodata=nodata) as dst:
            dst.write(data, 1)
        return str(path)
    return write


def test_native_dem(raster):
    grid, transform = ee.grid_for_bbox((0, 0, 4 / 3600, 4 / 3600))
    data = np.arange(16, dtype=np.float32).reshape(4, 4)
    np.testing.assert_array_equal(ee.resample_dem(raster(data, ee.STEP), grid, transform), data)


def test_jrc_nodata(raster):
    grid, transform = ee.grid_for_bbox((0, 0, 4 / 3600, 4 / 3600))
    data = np.array([[255, 100, 0, 50]] * 4, dtype=np.uint8)
    np.testing.assert_array_equal(ee.resample_jrc(raster(data, ee.STEP, 255), grid, transform), data)


def test_worldcover_mode(raster):
    grid, transform = ee.grid_for_bbox((0, 0, 4 / 3600, 4 / 3600))
    data = np.tile(np.array([[10, 10], [10, 50]], np.uint8), (4, 4))
    result = ee.resample_worldcover(raster(data, ee.STEP / 2), grid, transform)
    np.testing.assert_array_equal(result, np.full((4, 4), 10))


@pytest.mark.parametrize('bbox', [(0, 0, 4 / 3600, 4 / 3600), (ee.STEP, ee.STEP, 4 * ee.STEP, 4 * ee.STEP)])
def test_population_sum(raster, bbox):
    grid, transform = ee.grid_for_bbox(bbox)
    data = np.array([[40, 80], [120, -9999]], np.float32)
    result = ee.resample_population(raster(data, 2 * ee.STEP, -9999), grid, transform)
    expected = 240 if grid.nx == 4 else 130
    assert result.sum() == pytest.approx(expected, rel=0.02)
    assert np.isfinite(result).all()
    assert (result >= 0).all()


def test_download_outputs(raster, tmp_path, monkeypatch):
    import json

    rasterio = pytest.importorskip('rasterio')
    data = np.full((4, 4), 10, np.float32)
    path = raster(data, ee.STEP)
    monkeypatch.setattr(ee, 'source_urls', lambda layer, bounds, country="NGA": [path])
    out = tmp_path / 'raw'
    report = ee.download('test', (0, 0, 4 / 3600, 4 / 3600), str(out))
    metadata = json.loads((out / 'grid.json').read_text())
    assert metadata['nx'] == 4
    assert metadata['sources']['dem']['credit'] == ee.SOURCES['dem']['credit']
    for layer in report['layers']:
        array = np.load(out / f'{layer}.npy')
        with rasterio.open(out / f'{layer}.tif') as src:
            np.testing.assert_array_equal(src.read(1), array)
            assert tuple(src.transform)[:6] == tuple(metadata['transform'])
        assert report['layers'][layer]['shape'] == [4, 4]


@pytest.mark.parametrize('honour_range', [True, False])
def test_fetch_resume_and_skip(tmp_path, monkeypatch, honour_range):
    import httpx

    path = tmp_path / 'vector.gz'
    path.write_bytes(b'ab')
    requests = []
    client = httpx.Client

    def handler(request):
        requests.append(request)
        assert request.headers['User-Agent'] == 'dryrun-pipeline/0.1'
        if request.method == 'HEAD':
            return httpx.Response(200, headers={'Content-Length': '6'})
        assert request.headers['Range'] == 'bytes=2-'
        if honour_range:
            return httpx.Response(206, content=b'cdef', headers={'Content-Range': 'bytes 2-5/6'})
        return httpx.Response(200, content=b'abcdef')

    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))
    ee.fetch_file('https://example.test/vector', str(path))
    assert path.read_bytes() == b'abcdef'
    ee.fetch_file('https://example.test/vector', str(path))
    assert [request.method for request in requests] == ['HEAD', 'GET', 'HEAD']


def test_sub_arcsecond_grid_is_exact():
    from fractions import Fraction

    grid, transform = ee.grid_for_bbox((-73.905, 40.720, -73.846, 40.765), Fraction(1, 3), Fraction(4, 9))
    assert (grid.nx, grid.ny) == (479, 486)
    w, s, e, n = grid.bounds_wgs84
    assert w <= -73.905 and s <= 40.720 and e >= -73.846 and n >= 40.765
    assert transform[0] == pytest.approx(4 / 9 / 3600) and transform[4] == pytest.approx(-1 / 3 / 3600)
    assert (e - w) / transform[0] == pytest.approx(grid.nx) and (n - s) / -transform[4] == pytest.approx(grid.ny)
    assert 10 < grid.dx_m < 10.6 and 10 < grid.dy_m < 10.6


def test_float_steps_are_rejected():
    with pytest.raises(ValueError, match="positive integer"):
        ee.grid_for_bbox((0, 0, 1, 1), 0.5)
