"""Run-time estimate for a scenario before it runs (owner: Eng A; Eng D's API calls estimate_s).

The solver's cost is cells x steps, and the step is the CFL limit dt = ALPHA * dx / sqrt(g h_max), so a run costs
about cells x simulated seconds x ns_per_cell_s, where ns_per_cell_s grows with how deep the water gets. That is
fitted per AOI on prod's stored elapsed_s (Cloud Run, rev 00046), against the storm's effective rain depth: the
storm total minus what interventions add in drainage over the storm. Unknown AOIs fall back to the CFL form.
Outside dryrun/sim, so it never changes a run_id.

Fit (prod rev 00046, the 18 demo runs; in-sample, so expect worse on new scenarios): see test_speed_estimate.
"""

from __future__ import annotations

import math

import numpy as np

from dryrun.contracts import AOIManifest, DrainUpgrade, ScenarioSpec, TideLevel

# effective rain mm -> ns per cell per simulated second, prod Cloud Run (no-intervention demo runs)
CALIBRATION: dict[str, list[tuple[float, float]]] = {
# The 0 mm points: the held lagoon / edge water keeps dt small even without rain (Lagos: drain sweeps that remove
# the rain run at ~3 ns); Queens' 67 mm point is the 118 mm storm with sewers x2.
    "lagos-lekki-v1": [(0.0, 3.4), (50.0, 3.46), (120.0, 6.74), (200.0, 6.61)],
    "lagos-lekki-v2": [(0.0, 3.4), (50.0, 3.46), (120.0, 6.74), (200.0, 6.61)],
    "nyc-queens-v0": [(66.8, 6.0), (118.0, 9.74), (181.0, 10.35)],
    "texas-guadalupe-v0": [(0.0, 3.43), (85.0, 4.30)],
}
K_CFL = 30.0  # ns per cell per simulated second per (sqrt(g h) / dx), median over the calibrated AOIs
OVERHEAD_S = 0.0  # the calibration is on total elapsed_s, which already includes input load and output writes
OTHER_INTERVENTION = 0.85  # any intervention but tide: shallower water, ~15 % less time on prod
TIDE_HIGH = 1.18  # a held level above the default makes deeper water, ~18 % more time (Lagos tide lock)
FAKE_S = 1.0
SPREAD = 0.3  # +-: worst in-sample miss 27 % (a drain-only scenario); new scenarios can miss more


def effective_rain_mm(spec: ScenarioSpec, base_drain_mm_h: float = 0.0, mean_rain_mm: float | None = None) -> float:
    """Storm depth over the AOI (mean_rain_mm: the area mean for a localized storm, from the rain field) minus
    extra whole-area drainage over the storm."""
    mm = float(spec.storm.total_mm if mean_rain_mm is None else mean_rain_mm)
    for iv in spec.interventions:
        if isinstance(iv, DrainUpgrade) and iv.polygon is None and iv.place is None:
            mm -= (iv.add_mm_h + (iv.capacity_factor - 1.0) * base_drain_mm_h) * spec.storm.duration_h
    return max(mm, 0.0)


def ns_per_cell_s(aoi: AOIManifest, spec: ScenarioSpec, base_drain_mm_h: float = 0.0,
                  mean_rain_mm: float | None = None) -> float:
    eff = effective_rain_mm(spec, base_drain_mm_h, mean_rain_mm)
    factor = 1.0
    if any(not isinstance(iv, TideLevel) for iv in spec.interventions):
        factor *= OTHER_INTERVENTION
    if any(isinstance(iv, TideLevel) and iv.boundary_level_m > -0.5 for iv in spec.interventions):
        factor *= TIDE_HIGH
    table = CALIBRATION.get(aoi.aoi_id)
    if table:
        x, y = zip(*sorted(table))
        if eff < x[0] and x[0] > 0:  # below the calibrated range: cost falls with the water, to a floor
            return factor * max(y[0] * eff / x[0], 0.5 * y[0])
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
            return (r.stop - r.start) * (c.stop - c.start)
        except Exception:  # noqa: BLE001 - an estimate must never fail a request
            pass
    return aoi.grid.nx * aoi.grid.ny


def estimate_s(aoi: AOIManifest, spec: ScenarioSpec, backend: str = "solver", cells: int | None = None) -> float:
    """Expected wall seconds on prod. cells: the simulated domain (defaults to the whole grid)."""
    if backend == "fake":
        return FAKE_S
    n = cells if cells is not None else domain_cells(aoi, spec)
    drain, rain = _aoi_inputs(aoi, spec)
    return round(OVERHEAD_S + ns_per_cell_s(aoi, spec, drain, rain) * 1e-9 * n * spec.sim_hours * 3600, 1)


def estimate(aoi: AOIManifest, spec: ScenarioSpec, backend: str = "solver", cells: int | None = None) -> dict:
    s = estimate_s(aoi, spec, backend, cells)
    return {"est_s": s, "low_s": round(s * (1 - SPREAD), 1), "high_s": round(s * (1 + SPREAD), 1)}
