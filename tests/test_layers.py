"""Eng A's layer rules in pipeline/build_layers.py (pure numpy, no raw data needed)."""

import numpy as np

from dryrun.pipeline import build_layers as bl


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
