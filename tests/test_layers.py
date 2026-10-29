"""Eng A's layer rules in pipeline/build_layers.py (pure numpy, no raw data needed)."""

import numpy as np
import pytest

from dryrun.contracts import GridSpec
from dryrun.pipeline import build_layers as bl
from dryrun.pipeline import inflows as fl


def _lekki_like(n=80):
    occ = np.zeros((n, n), np.float32)
    occ[:6] = 100  # lagoon NORTH
    occ[-5:] = 99  # Atlantic SOUTH
    occ[30:34, 30:34] = 95  # small inland pond: excluded, not a boundary
    occ[6:-5, 50] = 92  # canal joining the two
    occ[40:45, 10:15] = 60  # seasonal: neither
    occ[0, 0] = 255  # JRC no-data
    return occ


def test_water_masks_find_lagoon_north_and_sea_south():
    b, ex = bl.water_masks(_lekki_like())
    assert b[2].all() and b[-2].all()
    assert not b[31, 31] and ex[31, 31]
    assert not ex[42, 12] and not ex[0, 0]
    assert ex[20, 50]


def test_treat_dem_smooths_land_and_keeps_water_below_tide():
    rng = np.random.default_rng(0)
    occ = _lekki_like()
    b, ex = bl.water_masks(occ)
    dem = 2.0 + rng.normal(0, 1.0, occ.shape)
    dem[ex] = 0.5  # GLO-30 water surfaces: flattened to an arbitrary height
    out = bl.treat_dem(dem, b, ex)
    land = ~ex
    assert out.dtype == np.float32
    assert out[land].std() < 0.6 * dem[land].std()  # noise reduced
    assert abs(out[land].mean() - dem[land].mean()) < 0.1  # no bias
    assert (out[b] <= bl.WATER_BED_M).all()
    canal = ex & ~b
    assert (out[canal] < dem[canal]).all()


def test_landcover_and_drains():
    man, inf = bl.landcover_layers(np.array([[50, 10], [80, 70]]))
    assert man[0, 0] == bl.LANDCOVER_LUT[50][0] and inf[1, 0] == 0.0 and man[1, 1] == bl.LUT_DEFAULT[0]
    d = np.zeros((2, 2), bool)
    c = d.copy()
    d[0, 0] = c[0, 0] = True
    c[1, 1] = True
    out = bl.drain_sink({"drain": d, "canal": c})
    assert out[0, 0] == bl.BASELINE_DRAIN_MM_H["canal"] and out[1, 1] == bl.BASELINE_DRAIN_MM_H["canal"]
    assert out[0, 1] == 0


def _valley(ny=30, nx=60):
    """Inland valley at ~480 m sloping east, with a 1-cell OSM river along row 15."""
    x = np.linspace(500, 470, nx)
    y = np.abs(np.arange(ny) - 15)[:, None] * 0.5
    dem = (x[None, :] + y).astype(np.float64)
    river = np.zeros((ny, nx), bool)
    river[15] = True
    return dem, river


def test_inland_has_no_jrc_boundary():
    occ = _lekki_like()
    b, ex = bl.water_masks(occ, coastal=False)
    assert not b.any() and ex[2].all()


def test_outlet_keeps_an_inland_bed_and_drains_the_channel():
    dem, river = _valley()
    b, ex = bl.water_masks(np.zeros(dem.shape, np.float32), coastal=False)
    ex |= river
    outlet = bl.river_outlet(river, "east")
    assert outlet.sum() == 1 and outlet[15, -1]
    out = bl.treat_dem(dem, b | outlet, ex, outlet)
    assert out[15, -1] > 400  # never lowered to the sea bed
    assert out[15, -1] < out[15, -2]  # a drop into the outlet: the river can leave
    assert (np.diff(out[15].astype(np.float64)) < 0).all()  # burned channel still runs downhill


def test_outlet_requires_the_river_to_reach_the_edge():
    _, river = _valley()
    river[:, -3:] = False
    with pytest.raises(ValueError):
        bl.river_outlet(river, "east")


def _grid(ny=30, nx=60):
    return GridSpec(cell_size_m=50, dx_m=50, dy_m=50, nx=nx, ny=ny, bounds_wgs84=(-99.6, 29.9, -99.0, 30.2))


def test_entry_cells_find_where_the_river_crosses_the_edge():
    _, river = _valley()
    cells = fl.entry_cells(_grid(), river, -99.6, 30.05)  # west edge, row 15 sits at 30.05
    assert [15, 0] in cells and all(c == 0 for _, c in cells)
    with pytest.raises(ValueError):
        fl.entry_cells(_grid(), np.zeros((30, 60), bool), -99.6, 30.05)
    outlet = bl.river_outlet(river, "east")
    with pytest.raises(ValueError):  # an entry on the outlet edge has nowhere legal to go
        fl.entry_cells(_grid(), river, -99.0, 30.05, boundary=outlet)


def test_hydrograph_is_a_clipped_signed_sum_from_t0():
    gauges = {"A": {"rows": [["2025-07-04T07:00", 100.0], ["2025-07-04T09:00", 900.0]]},
              "B": {"rows": [["2025-07-04T07:00", 150.0], ["2025-07-04T09:00", 100.0]]}}
    h = dict((t, q) for t, q in fl.hydrograph(gauges, {"A": 1, "B": -1}, "2025-07-04T07:00", 3))
    assert h[0.0] == 0.0  # 100 - 150 clipped
    assert h[7200.0] == 800.0 and h[3 * 3600.0] == 800.0  # held after the last reading
    led = dict((t, q) for t, q in fl.hydrograph(gauges, {"A": [1, 60]}, "2025-07-04T07:00", 3))
    assert led[0.0] == 500.0  # read 60 min later: the water enters before the gauge downstream sees it


def test_carving_breaches_ridges_and_never_raises():
    dem, river = _valley()
    dem[15, 30] += 12.0  # a canyon averaged into a ridge across the bed
    outlet = bl.river_outlet(river, "east")
    out = bl.carve_rivers(dem, river, outlet).astype(np.float64)
    assert (np.diff(out[15]) < 0).all()  # downhill all the way to the outlet
    assert (out <= dem + 1e-4).all() and np.array_equal(out[~river], dem[~river].astype(np.float32))
