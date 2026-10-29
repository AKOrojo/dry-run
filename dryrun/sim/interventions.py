"""Turn ScenarioSpec interventions into modified solver inputs (owner: Eng A).

Interventions change PHYSICS inputs, never outputs. That is the whole pitch:
the A/B difference the UI shows comes from the solver, not from a fudge factor.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

from dryrun.contracts import (
    DrainUpgrade,
    GreenInfrastructure,
    GridSpec,
    RetentionPond,
    ScenarioSpec,
    TideLevel,
)


@dataclass(frozen=True)
class Inflow:
    """River inflow at a set of cells (flat indices row*nx+col), e.g. a USGS gauge hydrograph."""

    cells: np.ndarray  # 1-D int64 flat indices; the volume is spread evenly over them
    discharge_m3s: Callable[[float], float]  # instantaneous Q at t seconds since the run start, >= 0


@dataclass
class SolverInputs:
    dem: np.ndarray  # m
    manning: np.ndarray
    infiltration_mm_h: np.ndarray
    drain_sink_mm_h: np.ndarray
    tide_level_m: float | None  # water level held at boundary_mask cells; None = default (-0.5 m)
    boundary_mask: np.ndarray | None = None  # bool [ny,nx]: open water (lagoon/sea) cells
    dx_m: float = 30.0
    dy_m: float = 30.0
    exclude_mask: np.ndarray | None = None  # bool: permanent water + pond cells (exposure ignores them)
    intervention_cells: list[int] | None = None  # cells touched per intervention (0 => warn)
    inflows: list[Inflow] | None = None  # river inflow sources (Texas preset); None = none


def polygon_mask(grid: GridSpec, polygon: list[tuple[float, float]]) -> np.ndarray:
    """Rasterise a lon/lat polygon onto the AOI grid (cell centres, even-odd rule).

    Uses the bounds_wgs84 affine approximation, which is accurate to well under a
    cell over a 10 km AOI. Eng D may swap in rasterio.features for real data.
    """
    w, s, e, n = grid.bounds_wgs84
    cols = w + (np.arange(grid.nx) + 0.5) * (e - w) / grid.nx
    rows = n - (np.arange(grid.ny) + 0.5) * (n - s) / grid.ny
    x, y = np.meshgrid(cols, rows)
    inside = np.zeros(x.shape, bool)
    pts = list(polygon)
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    for (x1, y1), (x2, y2) in zip(pts[:-1], pts[1:]):
        crosses = (y1 > y) != (y2 > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
        inside ^= crosses & (x < xin)
    return inside


def place_polygon(aoi_id: str, name: str) -> list[tuple[float, float]]:
    """Resolve a `places` feature name (case-insensitive) to its outer ring."""
    import json

    from dryrun import storage

    feats = json.loads(storage.load_aoi_file(aoi_id, "places"))["features"]
    for f in feats:
        if f["properties"]["name"].lower() == name.lower():
            if f["geometry"]["type"] != "Polygon":
                raise ValueError(f"place {name!r} must be a Polygon")
            return [(p[0], p[1]) for p in f["geometry"]["coordinates"][0]]  # drop any z
    raise ValueError(f"unknown place {name!r}; call get_aoi_info for valid names")


def area_mask(spec: ScenarioSpec, grid: GridSpec, iv, default_all: bool = False) -> np.ndarray:
    if iv.place is not None:
        return polygon_mask(grid, place_polygon(spec.aoi_id, iv.place))
    if iv.polygon is not None:
        return polygon_mask(grid, iv.polygon)
    if default_all:
        return np.ones((grid.ny, grid.nx), bool)
    raise ValueError("intervention needs polygon or place")


def apply(spec: ScenarioSpec, grid: GridSpec, base: SolverInputs) -> SolverInputs:
    dem = base.dem.copy()
    manning = base.manning.copy()
    infil = base.infiltration_mm_h.copy()
    sink = base.drain_sink_mm_h.copy()
    tide = base.tide_level_m
    exclude = (base.exclude_mask.copy() if base.exclude_mask is not None else np.zeros(dem.shape, bool))
    changed: list[int] = []  # cells whose inputs ACTUALLY changed (0 => intervention did nothing)
    for iv in spec.interventions:
        if isinstance(iv, DrainUpgrade):
            m = area_mask(spec, grid, iv, default_all=True)
            before = sink.copy()
            sink[m] = sink[m] * iv.capacity_factor + iv.add_mm_h  # add_mm_h = new drains where none mapped
            changed.append(int((sink != before).sum()))
        elif isinstance(iv, GreenInfrastructure):
            m = area_mask(spec, grid, iv)
            b_inf, b_man = infil.copy(), manning.copy()
            infil[m] = np.maximum(infil[m], iv.infiltration_mm_h)
            manning[m] = np.maximum(manning[m], iv.manning)
            changed.append(int(((infil != b_inf) | (manning != b_man)).sum()))
        elif isinstance(iv, RetentionPond):
            m = area_mask(spec, grid, iv) & ~exclude  # never dig a pond in existing water
            dem[m] -= iv.depth_m
            exclude |= m  # stored pond water is the intervention working, not flooding
            changed.append(int(m.sum()))
        elif isinstance(iv, TideLevel):
            tide = iv.boundary_level_m
            changed.append(int(base.boundary_mask.sum()) if base.boundary_mask is not None else 0)
        else:  # RoadClosure: routing-only
            changed.append(int(area_mask(spec, grid, iv).sum()))
    return SolverInputs(dem, manning, infil, sink, tide, base.boundary_mask, base.dx_m, base.dy_m,
                        exclude, changed, base.inflows)


def pond_mask(spec: ScenarioSpec, grid: GridSpec, existing_water: np.ndarray | None = None) -> np.ndarray:
    """Cells actually dug as ponds (same rule as apply(): never in existing water, so bridges stay)."""
    m = np.zeros((grid.ny, grid.nx), bool)
    for iv in spec.interventions:
        if isinstance(iv, RetentionPond):
            m |= area_mask(spec, grid, iv)
    return m if existing_water is None else m & ~existing_water


def validate_areas(spec: ScenarioSpec, grid: GridSpec) -> None:
    """Resolve every place name up front so a typo is a 400 / tool error, not a failed run."""
    for iv in spec.interventions:
        if getattr(iv, "place", None) is not None:
            place_polygon(spec.aoi_id, iv.place)


def t_end_s(spec: ScenarioSpec) -> int:
    """Simulation end time, rounded to whole minutes. Both backends and the engine use this."""
    return int(round(spec.sim_hours * 60)) * 60


def rain_rate_mm_h(spec: ScenarioSpec, t_s: float) -> float:
    """Hyetograph: rain intensity at time t (spatially uniform over the AOI)."""
    dur = spec.storm.duration_h * 3600
    if t_s >= dur or spec.storm.total_mm == 0:
        return 0.0
    mean = spec.storm.total_mm / spec.storm.duration_h
    x = t_s / dur
    p = spec.storm.pattern.value
    if p == "uniform":
        return mean
    if p == "front_loaded":
        return mean * 2 * (1 - x)  # integrates to mean over [0,1]
    return mean * (2 - 4 * abs(x - 0.5))  # center_peaked triangle, integrates to mean


def rain_cum_mm(spec: ScenarioSpec, t_s: float) -> float:
    """Exact integral of rain_rate_mm_h from 0 to t (mm). The solver adds rain per step as
    rain_cum_mm(t + dt) - rain_cum_mm(t), so the storm total is exact whatever the step size."""
    total = spec.storm.total_mm
    x = min(max(t_s / (spec.storm.duration_h * 3600), 0.0), 1.0)
    p = spec.storm.pattern.value
    if p == "uniform":
        return total * x
    if p == "front_loaded":
        return total * (2 * x - x * x)
    return total * (2 * x * x if x <= 0.5 else 1 - 2 * (1 - x) ** 2)
