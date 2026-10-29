"""Acceptance tests for the local-inertial solver (owner: Eng A). See the list in dryrun/sim/solver.py.

Physics tests call solver.integrate directly on small synthetic grids. Intervention tests go through
the engine with the solver backend in their own storage folder, so they never share a cache with
test_core (which runs on the fake). The perf test only runs with FT_PERF=1.
"""

import math
import os
import time

import numpy as np
import pytest

os.environ["DRYRUN_STORAGE"] = "local"

from dryrun.contracts import (  # noqa: E402
    DrainUpgrade,
    GreenInfrastructure,
    RetentionPond,
    ScenarioSpec,
    Storm,
    TideLevel,
)
from dryrun.pipeline import fixtures  # noqa: E402
from dryrun.sim import solver  # noqa: E402
from dryrun.sim.interventions import Inflow, SolverInputs, rain_cum_mm, rain_rate_mm_h  # noqa: E402

try:
    import numba  # noqa: F401

    KERNELS = ["numpy", "numba"]
except ImportError:
    KERNELS = ["numpy"]

STORM = Storm(total_mm=120, duration_h=3)


def flat(ny, nx, z=0.0, n=0.03, dx=30.0, bnd=None, tide=None):
    zz = np.full((ny, nx), z, np.float32) if np.isscalar(z) else np.asarray(z, np.float32)
    zero = np.zeros((ny, nx), np.float32)
    return SolverInputs(zz, zero + n, zero, zero, tide, bnd, dx, dx)


# ------------------------------------------------------------------ physics on synthetic grids
@pytest.mark.parametrize("kernel", KERNELS)
def test_still_water_flat_bed_stays_still(kernel):
    inp = flat(20, 30)
    frames, led = solver.integrate(inp, [600, 3600], h0=np.full((20, 30), 1.0), kernel=kernel)
    assert np.abs(frames[-1][1] - 1.0).max() < 1e-6
    assert all(abs(v) < 1e-6 for v in led.values())


@pytest.mark.parametrize("kernel", KERNELS)
def test_lake_at_rest_on_bumpy_bed_with_dry_islands(kernel):
    rng = np.random.default_rng(1)
    z = rng.uniform(-1.0, 0.6, (25, 25))  # water level 0: cells above it are dry islands
    h0 = np.maximum(0.0 - z, 0.0)
    frames, _ = solver.integrate(flat(25, 25, z), [3600], h0=h0, kernel=kernel)
    assert np.abs(frames[-1][1] - h0).max() < 1e-6


def _stoker(hl, hr, g=9.81):
    """Wet-bed dam break (Stoker 1957): middle depth hm and shock speed s."""
    cl = math.sqrt(g * hl)
    lo, hi = hr, hl
    for _ in range(200):  # bisection on the shock/rarefaction matching condition
        hm = 0.5 * (lo + hi)
        u_rare = 2 * (cl - math.sqrt(g * hm))
        u_shock = (hm - hr) * math.sqrt(0.5 * g * (hm + hr) / (hm * hr))
        lo, hi = (hm, hi) if u_rare > u_shock else (lo, hm)
    s = hm * u_rare / (hm - hr)
    return hm, s


@pytest.mark.parametrize("kernel", KERNELS)
def test_dam_break_front_speed(kernel):
    nx, dx, hl, hr, t = 600, 1.0, 1.0, 0.5, 30.0
    h0 = np.where(np.arange(nx) < nx // 2, hl, hr)[None, :].repeat(3, 0)
    frames, _ = solver.integrate(flat(3, nx, n=0.0, dx=dx), [t], h0=h0, kernel=kernel)
    hm, s = _stoker(hl, hr)
    d = frames[-1][1][1]
    front = (np.nonzero(d > 0.5 * (hm + hr))[0].max() + 0.5) * dx - nx // 2 * dx
    assert abs(front - s * t) / (s * t) < 0.10, (front, s * t)
    assert abs(d[nx // 2 + int(0.5 * s * t)] - hm) / hm < 0.10  # plateau depth too


@pytest.mark.parametrize("kernel", KERNELS)
def test_rain_on_closed_box_is_conserved_and_never_negative(kernel):
    rng = np.random.default_rng(3)
    inp = flat(30, 30, rng.uniform(0, 3, (30, 30)))
    inp.infiltration_mm_h[:] = 5.0
    inp.drain_sink_mm_h[:10] = 20.0
    frames, led = solver.integrate(inp, [1800, 7200], rain_m=lambda a, b: 0.05 * (b - a) / 3600, kernel=kernel)
    stored = float(frames[-1][1].astype(np.float64).sum()) * 900
    err = led["rain_volume_m3"] - led["drained_volume_m3"] - led["infiltrated_volume_m3"] - stored
    assert abs(err) / led["rain_volume_m3"] < 1e-5
    assert min(f.min() for _, f in frames) >= 0


@pytest.mark.parametrize("kernel", KERNELS)
def test_high_tide_flows_in_through_boundary_cells_anywhere(kernel):
    # Boundary on the NORTH row (like the Lekki lagoon), land below the tide: water must flow IN.
    bnd = np.zeros((20, 20), bool)
    bnd[0] = True
    z = np.full((20, 20), 0.2)
    z[0] = -1.0
    frames, led = solver.integrate(flat(20, 20, z, bnd=bnd, tide=0.5), [7200], kernel=kernel)
    d = frames[-1][1]
    assert led["boundary_outflow_m3"] < 0  # net INFLOW
    assert d[-1].mean() > 0.2  # the far (south) end flooded too
    stored = float((d.astype(np.float64) - frames[0][1]).sum()) * 900
    assert abs(stored + led["boundary_outflow_m3"]) / stored < 1e-6


@pytest.mark.skipif(len(KERNELS) < 2 or os.geteuid() == 0, reason="needs numba and a non-root user")
def test_numba_runs_without_a_writable_cache(tmp_path):
    # Production image: /app is read-only for uid 10001. cache=True must not crash the solver there.
    import shutil
    import subprocess
    import sys
    from pathlib import Path

    src = tmp_path / "ro"
    shutil.copytree(Path(solver.__file__).parents[1], src / "dryrun",
                    ignore=shutil.ignore_patterns("__pycache__"))
    for p in sorted(src.rglob("*"), reverse=True) + [src]:
        p.chmod(p.stat().st_mode & ~0o222)
    env = {k: v for k, v in os.environ.items() if k != "NUMBA_CACHE_DIR"}
    nohome = str(src / "nohome")  # inside the read-only tree, so numba cannot create a user cache dir
    env.update(HOME=nohome, XDG_CACHE_HOME=nohome, PYTHONPATH=str(src),
               PYTHONDONTWRITEBYTECODE="1")
    try:
        r = subprocess.run([sys.executable, "-c", "from dryrun.sim.solver import warmup; warmup()"],
                           cwd=tmp_path, env=env, capture_output=True, text=True, timeout=300)
    finally:
        for p in [src] + list(src.rglob("*")):
            p.chmod(p.stat().st_mode | 0o200)
    assert r.returncode == 0, r.stderr[-800:]


def test_kernels_agree():
    if len(KERNELS) < 2:
        pytest.skip("numba not installed")
    rng = np.random.default_rng(5)
    bnd = np.zeros((40, 40), bool)
    bnd[-2:] = True
    inp = flat(40, 40, rng.uniform(-0.5, 2, (40, 40)), bnd=bnd, tide=0.0)
    rain = lambda a, b: 0.08 * (b - a) / 3600  # noqa: E731
    (fa, la), (fb, lb) = (solver.integrate(inp, [3600], rain, kernel=k) for k in KERNELS)
    assert np.abs(fa[-1][1] - fb[-1][1]).max() < 1e-5
    assert all(abs(la[k] - lb[k]) <= 1e-6 * max(1.0, abs(la[k])) for k in la)


def test_rain_integral_matches_hyetograph():
    for pattern in ("uniform", "front_loaded", "center_peaked"):
        spec = ScenarioSpec(aoi_id="x", storm=Storm(total_mm=90, duration_h=3, pattern=pattern))
        ts = np.linspace(0, 4 * 3600, 4001)
        rate = np.array([rain_rate_mm_h(spec, t) for t in ts]) / 3600
        cum = np.concatenate([[0], np.cumsum(0.5 * (rate[1:] + rate[:-1]) * np.diff(ts))])
        exact = np.array([rain_cum_mm(spec, t) for t in ts])
        assert np.abs(cum - exact).max() < 0.05 and abs(exact[-1] - 90) < 1e-9


# ------------------------------------------------------------- the fixture AOI through the engine
@pytest.fixture(scope="module")
def engine(tmp_path_factory):
    import dryrun.sim as sim
    from dryrun import storage
    from dryrun.sim import engine as eng

    mp = pytest.MonkeyPatch()
    root = tmp_path_factory.mktemp("solver")
    mp.setattr(storage, "LOCAL_DATA", root / "data")
    mp.setattr(storage, "LOCAL_RUNS", root / "runs")
    mp.setattr(eng, "BACKEND", "solver")
    mp.setattr(sim, "SOLVER_VERSION", "solver-" + sim.SOLVER_VERSION.split("-", 1)[1])
    storage.clear_caches()
    fixtures.build()
    yield eng
    mp.undo()
    storage.clear_caches()


def river(inflows=None, bnd=None):
    """40 x 80 closed box sloping 2 m -> 0 m along x, inflow on column 1 (a river entering at the west edge)."""
    inp = flat(40, 80, np.tile(np.linspace(2.0, 0.0, 80), (40, 1)), n=0.035, bnd=bnd)
    inp.inflows = inflows
    return inp


def pulse(t):
    return 20.0 if t < 1800 else 0.0  # m3/s for 30 min: 36,000 m3


WEST = np.arange(18, 23) * 80 + 1  # rows 18-22, column 1


@pytest.mark.parametrize("kernel", KERNELS)
def test_inflow_is_conserved_and_flows_downhill(kernel):
    frames, led = solver.integrate(river([Inflow(WEST, pulse)]), [3600], kernel=kernel)
    d = frames[-1][1].astype(np.float64)
    assert abs(led["inflow_volume_m3"] - 36_000) / 36_000 < 0.005  # trapezoid error only at the 1800 s step
    assert abs(d.sum() * 900 - led["inflow_volume_m3"]) / led["inflow_volume_m3"] < 1e-5
    cols = d.sum(axis=0)
    assert (cols * np.arange(80)).sum() / cols.sum() > 10 and d.min() >= 0  # the water moved downhill, away


def test_inflow_kernels_agree():
    if len(KERNELS) < 2:
        pytest.skip("numba not installed")
    (fa, _), (fb, _) = (solver.integrate(river([Inflow(WEST, pulse)]), [3600], kernel=k) for k in KERNELS)
    assert np.allclose(fa[-1][1], fb[-1][1], atol=1e-6)


@pytest.mark.parametrize("kernel", KERNELS)
def test_no_inflow_is_bit_identical(kernel):
    rain = lambda a, b: 0.04 * (b - a) / 3600  # noqa: E731
    (fa, la), (fb, lb) = (solver.integrate(river(i), [1800, 3600], rain, kernel=kernel) for i in (None, []))
    assert all(np.array_equal(a, b) for (_, a), (_, b) in zip(fa, fb))
    assert la == lb and la["inflow_volume_m3"] == 0.0


def test_inflow_rejects_boundary_and_empty_cells():
    bnd = np.zeros((40, 80), bool)
    bnd[:, 1] = True
    with pytest.raises(ValueError):
        solver.integrate(river([Inflow(WEST, pulse)], bnd=bnd), [60])
    with pytest.raises(ValueError):
        solver.integrate(river([Inflow(np.array([], np.int64), pulse)]), [60])


def run(engine, *ivs, **kw):
    m = engine.run_scenario(ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=kw.pop("storm", STORM),
                                         interventions=list(ivs), **kw))
    assert m.status == "done" and m.backend == "solver", m.error
    return m


def test_fixture_mass_balance_and_frames(engine):
    m = run(engine)
    assert abs(m.stats.mass_balance_error_pct) < 1.0
    assert m.frames[0].t_s == 0 and m.frames[-1].t_s == 6 * 3600 and len(m.frames) == 37
    assert m.stats.rain_volume_m3 > 0 and m.stats.boundary_outflow_m3 > 0 and m.stats.inflow_volume_m3 == 0
    assert 0.3 < m.stats.max_depth_m < 3  # pits pond tens of cm to ~1 m, not tens of metres


def test_engine_feeds_an_inflows_layer_to_the_solver(engine):
    import json

    from dryrun import storage

    m = storage.load_aoi(fixtures.AOI_ID)
    new = "fixture-inflow"
    for rel in set(m.layers.values()):
        storage.write_aoi_file(new, rel, storage.load_aoi_file(fixtures.AOI_ID, next(
            k for k, v in m.layers.items() if v == rel)))
    bnd = storage.load_raster(fixtures.AOI_ID, "boundary_mask") > 0.5
    r = next(i for i in range(bnd.shape[0]) if not bnd[i, 0])
    layer = {"t0_utc": "2025-07-04T07:00", "note": "test",
             "sources": [{"name": "test creek", "gauges": {}, "cells": [[r, 0]],
                          "hydrograph": [[0, 5.0], [3600, 5.0], [3900, 0.0]]}]}
    storage.write_aoi_file(new, "inflows.json", json.dumps(layer).encode(), "application/json")
    man = m.model_copy(update={"aoi_id": new, "layers": {**m.layers, "inflows": "inflows.json"}})
    storage.write_aoi_file(new, "manifest.json", man.model_dump_json().encode(), "application/json")
    out = engine.run_scenario(ScenarioSpec(aoi_id=new, storm=Storm(total_mm=0, duration_h=3)))
    assert out.status == "done", out.error
    assert abs(out.stats.inflow_volume_m3 - 5.0 * 3750) < 1.0  # 1 h at 5 m3/s plus the 5 min ramp down
    assert abs(out.stats.mass_balance_error_pct) < 1.0 and out.stats.rain_volume_m3 == 0


def test_own_cell_building_count_is_stricter(engine):
    m = run(engine)
    s = m.stats
    assert 0 < s.buildings_flooded_own_cell <= s.buildings_flooded
    a = engine.area_stats(m.run_id, "North Estate (synthetic)")
    assert a["buildings_flooded_own_cell"] <= a["buildings_flooded"]


def test_odd_duration_ends_on_final_state(engine):
    m = run(engine, sim_hours=2.5, output_interval_min=60)
    assert [f.t_s for f in m.frames] == [0, 3600, 7200, 9000]
    assert abs(m.stats.mass_balance_error_pct) < 1.0


def test_deterministic(engine):
    from dryrun.sim.engine import _load_inputs

    spec = ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=STORM, sim_hours=1)
    _, inp = _load_inputs(spec)
    (fa, la), (fb, lb) = solver.simulate(inp, spec, 30.0), solver.simulate(inp, spec, 30.0)
    assert la == lb and all(np.array_equal(a[1], b[1]) for a, b in zip(fa, fb))


POLY = [(3.488, 6.457), (3.500, 6.457), (3.500, 6.446), (3.488, 6.446)]  # inside the fixture AOI
IMPACTS = ("buildings_flooded", "people_exposed", "flooded_area_km2")


@pytest.mark.parametrize("iv", [
    DrainUpgrade(capacity_factor=3),
    DrainUpgrade(add_mm_h=40),
    GreenInfrastructure(polygon=POLY, infiltration_mm_h=60),
], ids=["drains_x3", "new_drains_everywhere", "green"])
def test_interventions_never_worsen(engine, iv):
    base, alt = run(engine).stats, run(engine, iv).stats
    assert alt.stored_volume_end_m3 <= base.stored_volume_end_m3 * 1.001
    for f in IMPACTS:
        assert getattr(alt, f) <= getattr(base, f), f


def test_new_drains_in_area_help(engine):
    base = run(engine).stats
    alt = run(engine, DrainUpgrade(add_mm_h=40, place="North Estate (synthetic)")).stats
    assert alt.buildings_flooded < base.buildings_flooded
    assert alt.drained_volume_m3 > base.drained_volume_m3


def test_pond_captures_water_and_never_worsens_impacts(engine):
    base = run(engine).stats
    alt = run(engine, RetentionPond(place="Open Field (synthetic)", depth_m=2)).stats
    assert alt.stored_volume_end_m3 >= base.stored_volume_end_m3
    for f in IMPACTS:
        assert getattr(alt, f) <= getattr(base, f), f


def test_tide_lock_hurts(engine):
    base, alt = run(engine).stats, run(engine, TideLevel(boundary_level_m=1.5)).stats
    assert alt.boundary_outflow_m3 < base.boundary_outflow_m3
    for f in IMPACTS:
        assert getattr(alt, f) >= getattr(base, f), f
    assert abs(alt.mass_balance_error_pct) < 1.0


def test_no_rain_no_flooding(engine):
    m = run(engine, storm=Storm(total_mm=0, duration_h=1))
    assert m.stats.buildings_flooded == 0 and m.stats.flooded_area_km2 == 0


# ----------------------------------------------------------------------------------- performance
@pytest.mark.skipif(os.getenv("FT_PERF") != "1", reason="set FT_PERF=1 (shared CI runners are noisy)")
def test_perf_333_grid_6h_under_60s():
    rng = np.random.default_rng(0)
    n = 333
    rr, cc = np.mgrid[0:n, 0:n]
    z = 3.0 - 3.0 * rr / n + 0.5 * np.sin(cc / 11) * np.cos(rr / 17) + rng.normal(0, 0.15, (n, n))
    bnd = np.zeros((n, n), bool)
    bnd[:4] = True  # lagoon NORTH ...
    bnd[-4:] = True  # ... and ocean SOUTH
    z[bnd] = -1.5
    inp = flat(n, n, z, n=0.03, bnd=bnd, tide=0.3)
    inp.infiltration_mm_h[:] = 3
    spec = ScenarioSpec(aoi_id="perf", storm=Storm(total_mm=200, duration_h=3), sim_hours=6)
    solver.warmup()
    t0 = time.time()
    frames, led = solver.simulate(inp, spec, 30.0)
    elapsed = time.time() - t0
    assert elapsed < 60, elapsed
    print(f"333x333 6 h: {elapsed:.1f} s")
