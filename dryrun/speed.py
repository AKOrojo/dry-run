"""Run-time estimate for a scenario before it runs (owner: Eng A; Eng D's API calls estimate_s).

The solver's cost is cells x steps, and the step is the CFL limit dt = ALPHA * dx / sqrt(g h_max), so a run costs
about cells x simulated seconds x ns_per_cell_s, where ns_per_cell_s grows with how deep the water gets. That is
fitted per AOI on prod's elapsed_s against the storm's effective rain depth: the storm total minus what
interventions add in drainage over the storm (plus what they take away: sewers at capacity_factor 0 drain nothing).
Unknown AOIs fall back to the CFL form. Outside dryrun/sim, so it never changes a run_id.

Fit: prod rev 00058 (2 vCPU Cloud Run), 7 forced runs through /simulate/stream on 2026-10-30 (Eng D,
data/_scratch/prod_timings.json): Lagos 50/120/200 mm and the tide lock, Texas replay, Queens LaGuardia and the
Queens hero (sewers full). Those ran 1.4-2.7x slower than the rev 00046 fit predicted; points not re-measured (the
0 mm floors, Queens 67 mm) are the rev 00046 values times the measured ratio for their AOI. Repeat runs of one
spec on prod vary by tens of percent, so SPREAD stays wide. An out-of-sample check (4 fresh specs, rev 00061,
data/_scratch/prod_timings_oos.json) ran 24-38 % under that fit. Three idle reruns of one Queens v1 spec on rev 00089
(2026-11-01, Eng D) ran 21-25 % over it. Over those 13 idle prod runs actual / estimate has a geometric mean of 1.036,
so SCALE went from 0.88 to 0.91.

The residuals cluster by host and day (Oct 30 x1.10, the Oct 30 checks x0.68-0.84, Nov 1 x1.21-1.25), not by AOI or storm:
Cloud Run hosts differ (numba warm-up took 9 s to 534 s on the same image). So each process also corrects itself from its
own finished solves (observe, called by the simulate route): host_factor is the shrunk geometric mean of actual / model
over its last HOST_RUNS solves. The first solve of an AOI in a process costs FIRST_SOLVE more (layers load, caches fill).
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections import deque
from functools import lru_cache

import numpy as np

from dryrun.contracts import AOIManifest, DrainUpgrade, ScenarioSpec, TideLevel

log = logging.getLogger("dryrun.speed")

# effective rain mm -> ns per cell per simulated second, prod Cloud Run rev 00058
CALIBRATION: dict[str, list[tuple[float, float]]] = {
# The 0 mm points: the held lagoon / edge water keeps dt small even without rain (Lagos drain sweeps that remove
# the rain); Queens' 238.8 mm point is the hero, 181 mm with the sewers full (12.8 mm/h x 4.5 h back).
    "lagos-lekki-v1": [(0.0, 5.8), (50.0, 5.92), (120.0, 9.39), (200.0, 13.09)],
    "lagos-lekki-v2": [(0.0, 5.8), (50.0, 5.92), (120.0, 9.39), (200.0, 13.09)],
    "nyc-queens-v0": [(66.8, 9.7), (118.0, 15.71), (238.8, 23.5)],
    # drainage AOIs (contract 0.8.0): same surface grid and cost; the drain network's cost is DRAIN_CHANNEL_COST
    "lagos-lekki-v3": [(0.0, 5.8), (50.0, 5.92), (120.0, 9.39), (200.0, 13.09)],
    "nyc-queens-v1": [(66.8, 9.7), (118.0, 15.71), (238.8, 23.5)],
    "texas-guadalupe-v0": [(0.0, 5.6), (85.0, 7.0)],
}
K_CFL = 48.0  # ns per cell per simulated second per (sqrt(g h) / dx): the rev 00046 value x 1.6, the median ratio
OVERHEAD_S = 0.0  # the calibration is on total elapsed_s, which already includes input load and output writes
OTHER_INTERVENTION = 0.85  # an intervention that removes water (drains, green, ponds): ~15 % less time (rev 00046)
TIDE_HIGH = 1.54  # a held level above the default makes deeper water: the Lagos tide lock, 14.45 vs 9.39 ns
EXTRAPOLATE_MAX = 1.5  # above the table, follow its last slope, at most this times its last value
SCALE = 0.91  # 13 idle prod runs (7 calibration, 4 out-of-sample, 2 Nov 1 reruns): 0.88 x their geometric mean 1.036
FAKE_S = 1.0
# Open-drain routing costs this x (channel nodes / simulated cells) on top of the surface solve: Lagos v3, 120 mm / 3 h,
# 41.6k nodes on 175k cells, 32.2 s against 21.7 s locally (+48 %). Closed sewer zones cost nothing measurable
# (Queens v1 Ida hour 12.2 s against 12.3 s).
DRAIN_CHANNEL_COST = 2.0
SPREAD = 0.4  # +-: rev 00046 to 00058 moved the same specs by 1.4-2.7x; one prod sample per spec
FIRST_SOLVE = 1.19  # Queens v1 on a warm instance, its first Queens solve: 37.0 s against 31.4 / 30.6 s after (Nov 1)
HOST_RUNS = 8  # host_factor looks at this process's last 8 solves
HOST_PRIOR = 2.0  # ... shrunk toward 1 as if 2 more solves had matched the model exactly
HOST_RATIO = (0.5, 2.5)  # one observation's actual / model is clamped to this (a run disturbed by a deploy: 2.06)

_lock = threading.Lock()
_ratios: deque[float] = deque(maxlen=HOST_RUNS)
_solved: set[str] = set()
_seen_runs: deque[str] = deque(maxlen=64)  # a run_id counts once (a second caller waits out the solve, then reads it)


def effective_rain_mm(spec: ScenarioSpec, base_drain_mm_h: float = 0.0, mean_rain_mm: float | None = None) -> float:
    """Storm depth over the AOI (mean_rain_mm: the area mean for a localized storm, from the rain field) minus
    extra whole-area drainage over the storm."""
    mm = float(spec.storm.total_mm if mean_rain_mm is None else mean_rain_mm)
    for iv in spec.interventions:
        if isinstance(iv, DrainUpgrade) and iv.polygon is None and iv.place is None:
            mm -= (iv.add_mm_h + (iv.capacity_factor - 1.0) * base_drain_mm_h) * spec.storm.duration_h
    return max(mm, 0.0)


def _removes_water(iv) -> bool:
    """Drains, green areas, ponds and the like; not a raised level, and not a drain made worse (sewers full)."""
    if isinstance(iv, TideLevel):
        return False
    if isinstance(iv, DrainUpgrade):
        return iv.add_mm_h > 0 or iv.capacity_factor > 1.0
    return True


def ns_per_cell_s(aoi: AOIManifest, spec: ScenarioSpec, base_drain_mm_h: float = 0.0,
                  mean_rain_mm: float | None = None) -> float:
    eff = effective_rain_mm(spec, base_drain_mm_h, mean_rain_mm)
    factor = 1.0
    if any(_removes_water(iv) for iv in spec.interventions):
        factor *= OTHER_INTERVENTION
    if any(isinstance(iv, TideLevel) and iv.boundary_level_m > -0.5 for iv in spec.interventions):
        factor *= TIDE_HIGH
    table = CALIBRATION.get(aoi.aoi_id)
    if table:
        x, y = zip(*sorted(table))
        if eff < x[0] and x[0] > 0:  # below the calibrated range: cost falls with the water, to a floor
            return factor * max(y[0] * eff / x[0], 0.5 * y[0])
        if eff > x[-1] and len(x) > 1:  # above it: deeper water keeps costing more (the old clamp missed 2.7x)
            slope = max((y[-1] - y[-2]) / (x[-1] - x[-2]), 0.0)
            return factor * min(y[-1] + slope * (eff - x[-1]), EXTRAPOLATE_MAX * y[-1])
        return factor * float(np.interp(eff, x, y))
    h = min(max(eff / 1000.0 * 15.0, 0.5), 5.0)  # rough peak depth: rain ponds ~15x in low spots
    return K_CFL * math.sqrt(9.81 * h) / aoi.grid.cell_size_m


def _aoi_inputs(aoi: AOIManifest, spec: ScenarioSpec) -> tuple[float, float | None]:
    """(mean existing drain mm/h on land, area-mean rain mm for a localized storm), from the AOI's layers.
    Falls back to (0, None) when the layers are not readable (estimates then lean high)."""
    try:
        from dryrun import storage
        from dryrun.sim import interventions

        land = ~(storage.load_raster(aoi.aoi_id, "exclude_mask") > 0.5)
        drain = float(storage.load_raster(aoi.aoi_id, "drain_sink_mm_h")[land].mean())
        rain = None
        if spec.storm.spatial is not None:
            rain = float(interventions.rain_total_mm(spec, aoi.grid, spec.sim_hours * 3600)[land].mean())
        return drain, rain
    except Exception:  # noqa: BLE001 - an estimate must never fail a request
        return 0.0, None


def domain_cells(aoi: AOIManifest, spec: ScenarioSpec) -> int:
    """Cells the solver will simulate: the rain-area window it crops to (domain rain_area), else the whole grid."""
    if spec.domain == "rain_area":
        try:
            from dryrun.sim import interventions

            r, c = interventions.rain_window(spec, aoi.grid)
            return int((r.stop - r.start) * (c.stop - c.start))  # plain int: callers put it in JSON
        except Exception:  # noqa: BLE001 - an estimate must never fail a request
            pass
    return aoi.grid.nx * aoi.grid.ny


@lru_cache(maxsize=8)
def _channel_nodes(aoi_id: str) -> dict[str, int]:
    """Drain-network channel nodes by channel type (cached: AOIs are immutable)."""
    import json
    from collections import Counter

    from dryrun import storage

    doc = json.loads(storage.load_aoi_file(aoi_id, "drain_network"))
    return dict(Counter(doc["nodes"]["channel"]))


def drainage_factor(aoi: AOIManifest, spec: ScenarioSpec, cells: int) -> float:
    """1 + DRAIN_CHANNEL_COST x the share of simulated cells carrying an open channel the run routes."""
    try:
        from dryrun.sim import drainage

        s = drainage.settings(spec, aoi)
        if s is None or not s.open:
            return 1.0
        nodes = _channel_nodes(aoi.aoi_id)
        n = sum(v for k, v in nodes.items() if s.roadside_gutters or k != "gutter")
        full = aoi.grid.nx * aoi.grid.ny
        n *= min(cells / full, 1.0)  # a rain window holds about its share of the network
        return 1.0 + DRAIN_CHANNEL_COST * n / max(cells, 1)
    except Exception:  # noqa: BLE001 - an estimate must never fail a request
        return 1.0


def _model_s(aoi: AOIManifest, spec: ScenarioSpec, cells: int | None) -> float:
    """The fitted prod seconds, before this host's correction."""
    n = cells if cells is not None else domain_cells(aoi, spec)
    drain, rain = _aoi_inputs(aoi, spec)
    per = ns_per_cell_s(aoi, spec, drain, rain) * drainage_factor(aoi, spec, n)
    first = FIRST_SOLVE if aoi.aoi_id not in _solved else 1.0
    return OVERHEAD_S + SCALE * first * per * 1e-9 * n * spec.sim_hours * 3600


def host_factor() -> float:
    """How much slower (>1) or faster this process has run than the model, from its recent solves."""
    with _lock:
        logs = [math.log(r) for r in _ratios]
    return math.exp(sum(logs) / (len(logs) + HOST_PRIOR)) if logs else 1.0


def observe(aoi: AOIManifest, spec: ScenarioSpec, elapsed_s: float, cells: int | None = None) -> None:
    """A solve finished in this process: feed its elapsed_s back into host_factor. Call it before the next solve of
    the same AOI starts, so the first-solve allowance still applies to this one."""
    if not elapsed_s or elapsed_s <= 0:
        return
    try:
        model = _model_s(aoi, spec, cells)
    except Exception:  # noqa: BLE001 - feedback must never fail a run
        return
    lo, hi = HOST_RATIO
    run_id = spec.run_id()
    with _lock:
        if run_id in _seen_runs:
            return
        _seen_runs.append(run_id)
        _ratios.append(min(max(elapsed_s / model, lo), hi))
        _solved.add(aoi.aoi_id)


def observe_run(spec: ScenarioSpec, m, wall_s: float) -> None:
    """observe() for a finished RunManifest. A manifest that came back from the cache (wall time shorter than its
    elapsed_s) was solved elsewhere: skipped. Never raises."""
    if getattr(m, "backend", None) != "solver" or not m.elapsed_s or wall_s < m.elapsed_s - 0.5:
        return
    try:
        from dryrun import storage

        observe(storage.load_aoi(spec.aoi_id), spec, m.elapsed_s, m.stats.domain_cells if m.stats else None)
    except Exception:  # noqa: BLE001 - feedback must never fail a run
        log.exception("speed.observe failed")


def run_and_observe(spec: ScenarioSpec):
    """engine.run_scenario, then observe_run on a background thread, so the caller never waits on the feedback.
    For solves outside the simulate stream (POST /api/simulate, the agent's run_simulation)."""
    from dryrun.sim.engine import run_scenario

    t0 = time.monotonic()
    m = run_scenario(spec)
    threading.Thread(target=observe_run, args=(spec, m, time.monotonic() - t0), daemon=True).start()
    return m


def reset() -> None:
    """Forget this process's solves (tests)."""
    with _lock:
        _ratios.clear()
        _solved.clear()
        _seen_runs.clear()


def estimate_s(aoi: AOIManifest, spec: ScenarioSpec, backend: str = "solver", cells: int | None = None) -> float:
    """Expected wall seconds on prod. cells: the simulated domain (defaults to the whole grid)."""
    if backend == "fake":
        return FAKE_S
    return round(_model_s(aoi, spec, cells) * host_factor(), 1)


def estimate(aoi: AOIManifest, spec: ScenarioSpec, backend: str = "solver", cells: int | None = None) -> dict:
    s = estimate_s(aoi, spec, backend, cells)
    return {"est_s": s, "low_s": round(s * (1 - SPREAD), 1), "high_s": round(s * (1 + SPREAD), 1)}
