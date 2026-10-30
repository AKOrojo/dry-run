"""Drain/sewer model (dryrun/sim/drainage.py, contract 0.8.0) on the drains fixture: mass balance, behaviour, outputs."""

import json
import os

os.environ["DRYRUN_STORAGE"] = "local"

import numpy as np  # noqa: E402
import pytest  # noqa: E402

from dryrun import storage  # noqa: E402
from dryrun.contracts import (  # noqa: E402
    Drainage,
    DrainFill,
    DrainUpgrade,
    RainCell,
    ScenarioSpec,
    Storm,
    TideLevel,
)
from dryrun.pipeline import drains, fixtures  # noqa: E402
from dryrun.sim import drainage, engine, solver  # noqa: E402

AOI = drains.FIXTURE_ID

pytest.importorskip("numba")  # the plain-Python drainage kernel is correct but far too slow for these runs


@pytest.fixture(scope="module", autouse=True)
def aoi(tmp_path_factory):
    root = tmp_path_factory.mktemp("drn")
    storage.LOCAL_DATA, storage.LOCAL_RUNS = root / "data", root / "runs"
    storage.clear_caches()
    drains.build_fixture()
    storage.clear_caches()
    yield


def _run(dr=None, iv=(), mm=120.0, hours=2.0, sim=4.0, aoi=AOI, **kw):
    spec = ScenarioSpec(aoi_id=aoi, storm=Storm(total_mm=mm, duration_h=hours, **kw), sim_hours=sim, drainage=dr,
                        interventions=list(iv))
    aoi_m, inp = engine._load_inputs(spec)
    frames, led = solver.integrate(inp, [1800 * k for k in range(1, int(sim * 2) + 1)],
                                   lambda a, b: (_cum(spec, b) - _cum(spec, a)) / 1000.0)
    return spec, inp, frames, led


def _cum(spec, t):
    from dryrun.sim.interventions import rain_cum_mm

    return rain_cum_mm(spec, t)


def _balance(inp, frames, led):
    area = inp.dx_m * inp.dy_m
    stored = float(frames[-1][1].astype(np.float64).sum() - frames[0][1].astype(np.float64).sum()) * area
    supplied = led["rain_volume_m3"] + led["inflow_volume_m3"]
    err = supplied - led["drained_volume_m3"] - led["infiltrated_volume_m3"] - led["boundary_outflow_m3"] - stored
    return 100 * err / max(supplied, 1.0)


@pytest.mark.parametrize("dr", [None, Drainage(system="closed"), Drainage(system="open"), Drainage(system="mixed"),
                                Drainage(outfall="blocked"), Drainage(outfall="free"),
                                Drainage(system="closed", capacity_mm_h=0.0)])
def test_mass_balance_and_ledger_identity(dr):
    _, inp, frames, led = _run(dr)
    assert abs(_balance(inp, frames, led)) < 0.1  # float32 frames; the ledger itself is exact
    s = led["_drainage"]["stats"]
    # the surface lost captured - surcharge, which went out or stayed in the drains
    assert led["drained_volume_m3"] == pytest.approx(s["drain_outfall_m3"] + s["drain_storage_end_m3"], abs=2.0)
    assert led["drained_volume_m3"] == pytest.approx(s["sewer_captured_m3"] - s["sewer_surcharge_m3"], abs=2.0)


def test_high_tide_without_gates_backs_up_and_balances():
    _, inp, frames, led = _run(None, [TideLevel(boundary_level_m=2.0)])
    assert abs(_balance(inp, frames, led)) < 0.1
    assert led["_drainage"]["stats"]["drain_outfall_m3"] < 0  # the sea came in through the outfalls


def test_no_rain_is_quiet():
    """No rain: the tidal canal starts at the receiving level and nothing is pumped in from the lagoon."""
    _, _, _, led = _run(Drainage(system="open"), mm=0.0)
    s = led["_drainage"]["stats"]
    assert abs(s["drain_outfall_m3"]) < 1000 and s["sewer_surcharge_m3"] < 20000
    assert led["_drainage"]["series"]["surcharge_m3_s"][-1] < 0.1


def _flooded(frames, inp):
    d = np.max([f for _, f in frames], axis=0)
    return int(((d >= 0.15) & ~inp.exclude_mask).sum())


def test_directions():
    base = _run(Drainage(system="closed"))
    small = _run(Drainage(system="closed", capacity_mm_h=10.0))
    big = _run(Drainage(system="closed", capacity_mm_h=80.0))
    assert _flooded(big[2], big[1]) <= _flooded(base[2], base[1]) <= _flooded(small[2], small[1])
    clean = _run(Drainage(blockage_pct=0))
    blocked = _run(Drainage(blockage_pct=80))
    assert _flooded(clean[2], clean[1]) < _flooded(blocked[2], blocked[1])
    out = _run(Drainage(outfall="blocked"))
    assert out[3]["_drainage"]["stats"]["drain_outfall_m3"] == 0
    assert _flooded(out[2], out[1]) > _flooded(clean[2], clean[1])
    gated = _run(Drainage(flap_gates=True), [TideLevel(boundary_level_m=2.0)])
    open_ = _run(Drainage(flap_gates=False), [TideLevel(boundary_level_m=2.0)])
    assert gated[3]["_drainage"]["stats"]["drain_outfall_m3"] >= 0
    assert _flooded(gated[2], gated[1]) <= _flooded(open_[2], open_[1])
    up = _run(None, [DrainUpgrade(capacity_factor=2.0)])
    assert _flooded(up[2], up[1]) <= _flooded(clean[2], clean[1]) + 50


def test_small_capacity_fills_and_surcharges():
    _, _, _, led = _run(Drainage(system="closed", capacity_mm_h=5.0), mm=200.0)
    s = led["_drainage"]["stats"]
    assert s["drain_full_t_s"] is not None and s["drain_peak_full_pct"] >= 95
    assert s["sewer_surcharge_m3"] > 0 and s["drain_surcharge_start_t_s"] is not None


def test_settings_resolution_and_errors():
    aoi_m = storage.load_aoi(AOI)
    spec = ScenarioSpec(aoi_id=AOI, storm=Storm(total_mm=10, duration_h=1))
    s = drainage.settings(spec, aoi_m)
    assert s.system == "mixed" and s.capacity_mm_h == 40.0 and s.blockage == pytest.approx(0.2)
    rp = drainage.settings(spec.model_copy(update={"drainage": Drainage(return_period_yr=10)}), aoi_m)
    assert rp.capacity_mm_h == 50.0
    with pytest.raises(ValueError, match="no design rate"):
        drainage.settings(spec.model_copy(update={"drainage": Drainage(return_period_yr=100)}), aoi_m)
    legacy = ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=Storm(total_mm=10, duration_h=1), drainage=Drainage())
    with pytest.raises(ValueError, match="no drain network"):
        engine.validate(legacy)


def test_engine_outputs_and_legacy_nulls(monkeypatch):
    monkeypatch.setattr(engine, "_backend", lambda: (solver.simulate, "solver"))
    spec = ScenarioSpec(aoi_id=AOI, storm=Storm(total_mm=100, duration_h=1), sim_hours=2, output_interval_min=30)
    m = engine.run_scenario(spec, force=True)
    assert m.status.value == "done" and m.drain_fill == "drain_fill.json" and m.drainage_limits
    st = m.stats
    assert st.sewer_captured_m3 > 0 and st.drain_peak_full_pct is not None
    assert abs(st.mass_balance_error_pct) < 0.1
    ts = m.timeseries
    assert len(ts.drain_full_pct) == len(ts.t_s) == len(m.frames) == len(ts.surcharge_m3_s)
    fill = DrainFill(**json.loads(storage._read_bytes("runs", f"{m.run_id}/drain_fill.json")))
    assert fill.t_s == ts.t_s and len(fill.fill_pct) == len(m.frames)
    assert all(len(row) == len(fill.ids) == len(fill.kind) for row in fill.fill_pct)
    assert any(k == "sewer_zone" for k in fill.kind) and all(i.split(":")[0] for i in fill.ids)
    gj = json.loads(storage.load_aoi_file(AOI, "drains_geojson"))
    assert set(fill.ids) <= {f["properties"]["id"] for f in gj["features"]}
    # the same scenario on an AOI without drains: every drainage output is null, not zero
    old = engine.run_scenario(spec.model_copy(update={"aoi_id": fixtures.AOI_ID}), force=True)
    assert old.drain_fill is None and old.drainage_limits is None and old.timeseries.drain_full_pct is None
    assert old.stats.sewer_captured_m3 is None and old.stats.drain_full_t_s is None


def test_run_id_without_drainage_unchanged():
    spec = ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=Storm(total_mm=10, duration_h=1))
    assert "drainage" not in json.dumps({k: v for k, v in spec.model_dump(mode="json").items() if v is not None})
    assert spec.run_id() != spec.model_copy(update={"drainage": Drainage()}).run_id()


def test_rain_area_window_balances(monkeypatch):
    monkeypatch.setattr(engine, "_backend", lambda: (solver.simulate, "solver"))
    w, s, e, n = storage.load_aoi(AOI).grid.bounds_wgs84
    cell = RainCell(center=((w + e) / 2, (s + n) / 2), radius_m=1000)
    spec = ScenarioSpec(aoi_id=AOI, storm=Storm(total_mm=150, duration_h=1, spatial=cell), sim_hours=2,
                        domain="rain_area", output_interval_min=30)
    m = engine.run_scenario(spec, force=True)
    assert m.status.value == "done", m.error
    assert abs(m.stats.mass_balance_error_pct) < 0.1 and m.stats.sewer_captured_m3 > 0


def test_numba_matches_python_kernel():
    spec = ScenarioSpec(aoi_id=AOI, storm=Storm(total_mm=50, duration_h=1))
    aoi_m, inp = engine._load_inputs(spec)
    rng = np.random.default_rng(1)
    h0 = rng.random(inp.dem.size) * 0.2
    outs = []
    for k in (drainage._step_loops, drainage._kernel()):
        dr = inp.drains
        dr.reset()
        drainage.prefill(dr, -0.5)
        h = h0.copy()
        n = len(dr.n_cell)
        work, eta = np.zeros(max(n, 1)), np.zeros(max(n, 1))
        tot = np.zeros(3)
        for _ in range(3):
            tot += np.array(k(h, inp.dx_m * inp.dy_m, 5.0, -0.5, 0, dr.s.flap_gates, dr.n_cell, dr.n_zb, dr.n_plan,
                              dr.n_dep, dr.n_w, dr.n_L, dr.n_vmax, dr.n_n, dr.n_weir, dr.n_grates, dr.n_out, dr.n_v,
                              dr.o_q, dr.l_a, dr.l_b, dr.l_len, dr.l_wf, dr.l_n2, dr.l_dep, dr.l_q, dr.z_qmax, dr.z_vmax, dr.z_inv, dr.z_low, dr.z_gated, dr.z_v,
                              dr.z_in_ptr, dr.z_in_cell, dr.z_in_n, dr.z_in_high, dr.z_sc_ptr, dr.z_sc_cell, 1.0, work, eta, drainage.R43))
        outs.append((h, tot, dr.n_v.copy(), dr.z_v.copy()))
    for a, b in zip(outs[0], outs[1]):
        np.testing.assert_allclose(a, b, rtol=1e-9, atol=1e-9)


def test_speed_counts_open_channels_only():
    from dryrun import speed

    aoi_m = storage.load_aoi(AOI)
    cells = aoi_m.grid.nx * aoi_m.grid.ny
    base = ScenarioSpec(aoi_id=AOI, storm=Storm(total_mm=50, duration_h=1))
    assert speed.drainage_factor(aoi_m, base.model_copy(update={"drainage": Drainage(system="closed")}), cells) == 1
    open_ = speed.drainage_factor(aoi_m, base.model_copy(update={"drainage": Drainage(system="open")}), cells)
    bare = speed.drainage_factor(aoi_m, base.model_copy(
        update={"drainage": Drainage(system="open", roadside_gutters=False)}), cells)
    assert open_ > bare > 1.0
    assert speed.drainage_factor(storage.load_aoi(fixtures.AOI_ID), base.model_copy(
        update={"aoi_id": fixtures.AOI_ID}), cells) == 1.0


def test_capacity_factor_zero_removes_drains_without_failing():
    """DrainUpgrade(capacity_factor=0), the old 'sewers full', removes the drains it covers (no zero-size drains)."""
    _, inp, frames, led = _run(None, [DrainUpgrade(capacity_factor=0)])
    assert len(inp.drains.n_cell) == 0 and len(inp.drains.z_qmax) == 0
    assert abs(_balance(inp, frames, led)) < 0.1
    s = led["_drainage"]["stats"]
    assert s["sewer_captured_m3"] == 0 and s["drain_peak_full_pct"] == 0
    w, s_, e, n = storage.load_aoi(AOI).grid.bounds_wgs84
    half = DrainUpgrade(capacity_factor=0, polygon=[(w, s_), ((w + e) / 2, s_), ((w + e) / 2, n), (w, n)])
    _, inp2, frames2, led2 = _run(None, [half])
    assert 0 < len(inp2.drains.n_cell) < len(_run(None)[1].drains.n_cell)
    assert abs(_balance(inp2, frames2, led2)) < 0.1


def test_no_inlets_on_open_water():
    bnd = storage.load_raster(AOI, "boundary_mask") > 0.5
    excl = storage.load_raster(AOI, "exclude_mask") > 0.5
    assert (storage.load_raster(AOI, "inlets_count")[bnd | excl] == 0).all()


def test_drains_layer_is_served():
    from fastapi.testclient import TestClient

    from dryrun.api.main import app

    r = TestClient(app).get(f"/api/aoi/{AOI}/layer/drains_geojson")
    assert r.status_code == 200 and r.json()["type"] == "FeatureCollection"
    assert TestClient(app).get(f"/api/aoi/{fixtures.AOI_ID}/layer/drains_geojson").status_code == 404
