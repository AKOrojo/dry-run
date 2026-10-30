"""Turn ScenarioSpec interventions into modified solver inputs (owner: Eng A).

Interventions change PHYSICS inputs, never outputs. That is the whole pitch:
the A/B difference the UI shows comes from the solver, not from a fudge factor.
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass
from typing import Callable

import numpy as np

from dryrun.contracts import (
    DrainUpgrade,
    GreenInfrastructure,
    GridSpec,
    RainCell,
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
    rain: RainField | None = None  # where the rain falls; None = uniform over the whole grid


@dataclass(frozen=True)
class RainField:
    """Spatial rain: the storm's depth at a cell = rain_cum_mm increment x shape(t)[cell] (0..1).

    generated_m2: area integral of the shape (m2), including any part outside the grid, so rain generated =
    depth increment x generated_m2. moving: the shape changes with t (re-evaluated every RAIN_UPDATE_S)."""

    shape: Callable[[float], np.ndarray]
    generated_m2: float
    moving: bool = False


RAIN_UPDATE_S = 60.0  # a moving cell's field is refreshed this often (<= radius / (4 x speed) for R >= 4.8 km)


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


def _local_xy(grid: GridSpec, lon0: float, lat0: float) -> tuple[np.ndarray, np.ndarray]:
    """Cell-centre offsets (east, north) in metres from (lon0, lat0), local equirectangular."""
    w, s, e, n = grid.bounds_wgs84
    lon = w + (np.arange(grid.nx) + 0.5) * (e - w) / grid.nx
    lat = n - (np.arange(grid.ny) + 0.5) * (n - s) / grid.ny
    kx = 111320.0 * np.cos(np.deg2rad(lat0))
    return np.meshgrid((lon - lon0) * kx, (lat - lat0) * 110540.0)


def _ring_area_m2(ring: list[tuple[float, float]]) -> float:
    a = np.asarray(ring, float)
    kx = 111320.0 * np.cos(np.deg2rad(a[:, 1].mean()))
    x, y = a[:, 0] * kx, a[:, 1] * 110540.0
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2)


def cell_center(spec: ScenarioSpec, cell: RainCell) -> tuple[float, float]:
    if cell.center is not None:
        return float(cell.center[0]), float(cell.center[1])
    ring = np.asarray(place_polygon(spec.aoi_id, cell.place), float)
    return float(ring[:, 0].mean()), float(ring[:, 1].mean())


def cell_profile(d: np.ndarray, radius_m: float, profile: str) -> np.ndarray:
    """0..1 intensity at distance d (m); radius_m is the e^-2 point (gaussian, exponential) or the edge (flat)."""
    q = d / radius_m
    if profile == "gaussian":
        return np.exp(-2.0 * q * q)
    if profile == "exponential":
        return np.exp(-2.0 * q)
    return (q <= 1.0).astype(np.float64)


def cell_area_m2(radius_m: float, profile: str) -> float:
    """Integral of cell_profile over the plane: gaussian sigma = R/2 -> 2 pi sigma^2; exponential
    lambda = R/2 -> 2 pi lambda^2; flat pi R^2."""
    return {"gaussian": np.pi * radius_m ** 2 / 2, "exponential": np.pi * radius_m ** 2 / 2,
            "flat": np.pi * radius_m ** 2}[profile]


def rain_field(spec: ScenarioSpec, grid: GridSpec) -> RainField | None:
    sp = spec.storm.spatial
    if sp is None:
        return None
    if isinstance(sp, RainCell):
        lon0, lat0 = cell_center(spec, sp)
        x, y = _local_xy(grid, lon0, lat0)
        prof, r = sp.profile.value, float(sp.radius_m)
        vx = vy = 0.0
        if sp.track is not None and sp.track.speed_m_s > 0:
            h = np.deg2rad(sp.track.heading_deg)
            vx, vy = sp.track.speed_m_s * np.sin(h), sp.track.speed_m_s * np.cos(h)

        tp = peak_time_s(spec)  # the cell is over its centre when the rain is heaviest

        def shape(t: float) -> np.ndarray:
            return cell_profile(np.hypot(x - vx * (t - tp), y - vy * (t - tp)), r, prof)

        return RainField(shape, cell_area_m2(r, prof), moving=bool(vx or vy))
    ring = place_polygon(spec.aoi_id, sp.place) if sp.place is not None else list(sp.polygon)
    m = polygon_mask(grid, ring).astype(np.float64)
    return RainField(lambda t: m, _ring_area_m2(ring))


def rain_total_mm(spec: ScenarioSpec, grid: GridSpec, t_end: float | None = None) -> np.ndarray:
    """Storm depth (mm) per cell over the run, exactly as the solver applies it (moving cells per RAIN_UPDATE_S)."""
    t_end = t_end_s(spec) if t_end is None else t_end
    f = rain_field(spec, grid)
    if f is None:
        return np.full((grid.ny, grid.nx), rain_cum_mm(spec, t_end))
    if not f.moving:
        return rain_cum_mm(spec, t_end) * f.shape(0.0)
    out = np.zeros((grid.ny, grid.nx))
    t = 0.0
    while t < t_end:
        t1 = min(t + RAIN_UPDATE_S, t_end)
        out += (rain_cum_mm(spec, t1) - rain_cum_mm(spec, t)) * f.shape(t)
        t = t1
    return out


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
                        exclude, changed, base.inflows, rain_field(spec, grid))


def pond_mask(spec: ScenarioSpec, grid: GridSpec, existing_water: np.ndarray | None = None) -> np.ndarray:
    """Cells actually dug as ponds (same rule as apply(): never in existing water, so bridges stay)."""
    m = np.zeros((grid.ny, grid.nx), bool)
    for iv in spec.interventions:
        if isinstance(iv, RetentionPond):
            m |= area_mask(spec, grid, iv)
    return m if existing_water is None else m & ~existing_water


DOMAIN_BUFFER_M = 1000.0  # rain_area window: buffer around the wetted cells
DOMAIN_RAIN_FRACTION = 0.01  # a cell is in the rain area if it gets >= 1 % of the storm's depth (total_mm)


def rain_window(spec: ScenarioSpec, grid: GridSpec) -> tuple[slice, slice]:
    """Rows/cols of the rain_area domain: the bounding box of the cells the storm wets, plus DOMAIN_BUFFER_M."""
    total = rain_total_mm(spec, grid)
    wet = total >= DOMAIN_RAIN_FRACTION * float(spec.storm.total_mm)
    if not wet.any():
        raise ValueError("the storm's rain area does not touch the model area")
    rows, cols = np.nonzero(wet.any(axis=1))[0], np.nonzero(wet.any(axis=0))[0]
    br, bc = int(math.ceil(DOMAIN_BUFFER_M / grid.dy_m)), int(math.ceil(DOMAIN_BUFFER_M / grid.dx_m))
    return (slice(max(rows[0] - br, 0), min(rows[-1] + br + 1, grid.ny)),
            slice(max(cols[0] - bc, 0), min(cols[-1] + bc + 1, grid.nx)))


def window_bbox(win: tuple[slice, slice], grid: GridSpec) -> tuple[float, float, float, float]:
    """lon/lat [w, s, e, n] of a rain window's outer cell edges (rows run north to south)."""
    w, s, e, n = grid.bounds_wgs84
    r, c = win
    return (round(w + c.start / grid.nx * (e - w), 6), round(n - r.stop / grid.ny * (n - s), 6),
            round(w + c.stop / grid.nx * (e - w), 6), round(n - r.start / grid.ny * (n - s), 6))


def in_window(spec: ScenarioSpec, grid: GridSpec, row: int, col: int) -> bool:
    """Whether a cell was simulated: always for domain aoi, inside the rain window for rain_area."""
    if spec.domain != "rain_area":
        return True
    r, c = rain_window(spec, grid)
    return r.start <= row < r.stop and c.start <= col < c.stop


def crop(inp: SolverInputs, win: tuple[slice, slice], shape: tuple[int, int]) -> SolverInputs:
    """Inputs for the window. Its edge ring joins the held boundary (open outflow at the default level), unless
    the window edge is the grid edge."""
    r, c = win
    ny, nx = shape
    edge = np.zeros((r.stop - r.start, c.stop - c.start), bool)
    if r.start > 0:
        edge[0, :] = True
    if r.stop < ny:
        edge[-1, :] = True
    if c.start > 0:
        edge[:, 0] = True
    if c.stop < nx:
        edge[:, -1] = True
    bnd = inp.boundary_mask[r, c] if inp.boundary_mask is not None else np.zeros_like(edge)
    rain = inp.rain
    if rain is not None:
        rain = RainField(lambda t, f=rain.shape: f(t)[r, c], rain.generated_m2, rain.moving)

    def cut(a):
        return None if a is None else np.ascontiguousarray(a[r, c])

    return dataclasses.replace(
        inp, dem=cut(inp.dem), manning=cut(inp.manning), infiltration_mm_h=cut(inp.infiltration_mm_h),
        drain_sink_mm_h=cut(inp.drain_sink_mm_h), boundary_mask=np.ascontiguousarray(bnd | edge),
        exclude_mask=cut(inp.exclude_mask), rain=rain)


def validate_areas(spec: ScenarioSpec, grid: GridSpec) -> None:
    """Resolve every place name up front so a typo is a 400 / tool error, not a failed run."""
    for iv in spec.interventions:
        if getattr(iv, "place", None) is not None:
            place_polygon(spec.aoi_id, iv.place)
    if getattr(spec.storm.spatial, "place", None) is not None:
        place_polygon(spec.aoi_id, spec.storm.spatial.place)


def t_end_s(spec: ScenarioSpec) -> int:
    """Simulation end time, rounded to whole minutes. Both backends and the engine use this."""
    return int(round(spec.sim_hours * 60)) * 60


def peak_time_s(spec: ScenarioSpec) -> float:
    """When the hyetograph peaks: the start for front_loaded, the middle for center_peaked and uniform. A moving
    cell passes over its centre at this time."""
    return 0.0 if spec.storm.pattern.value == "front_loaded" else spec.storm.duration_h * 3600 / 2


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
