"""Run orchestration: ScenarioSpec -> RunManifest on storage (owner: Eng A, API-facing).

This is the ONE function the API and the agent call to simulate:
    run_scenario(spec) -> RunManifest
Content-addressed by run_id, so repeated scenarios are free. One solve at a time per
process (CPU-bound; Cloud Run scales instances instead), and concurrent requests for the
same run_id wait for the first instead of computing twice.
"""

from __future__ import annotations

import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

from dryrun import jobs, storage
from dryrun.contracts import FrameRef, RunManifest, RunStats, RunStatus, ScenarioSpec, Timeseries
from dryrun.sim import BACKEND, exposure, interventions

# RGBA per depth bin, matches RunManifest.colormap default edges [0.05,0.15,0.3,0.5,1,2]
_COLORS = np.array([
    [0, 0, 0, 0],          # < 0.05 m transparent
    [158, 202, 225, 120],  # 0.05-0.15
    [107, 174, 214, 160],
    [66, 146, 198, 190],
    [33, 113, 181, 210],
    [8, 81, 156, 230],
    [8, 48, 107, 245],     # >= 2 m
], np.uint8)
_EDGES = np.array([0.05, 0.15, 0.3, 0.5, 1.0, 2.0])

_SOLVE = threading.Semaphore(1)
_INFLIGHT: dict[str, threading.Lock] = {}
_INFLIGHT_GUARD = threading.Lock()
_IO = ThreadPoolExecutor(16)  # parallel uploads: ~80 objects per run in GCS mode


def depth_png(depth: np.ndarray, exclude: np.ndarray | None = None) -> bytes:
    d = depth if exclude is None else np.where(exclude, 0.0, depth)  # permanent water not painted as flood
    buf = io.BytesIO()
    Image.fromarray(_COLORS[np.digitize(d, _EDGES)], "RGBA").save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def _npy16(depth: np.ndarray) -> bytes:
    buf = io.BytesIO()
    np.save(buf, depth.astype(np.float16))
    return buf.getvalue()


def _backend():
    if BACKEND == "solver":
        from dryrun.sim import solver

        return solver.simulate, "solver"
    from dryrun.sim import fake

    return fake.simulate, "fake"


def _load_inputs(spec: ScenarioSpec):
    aoi = storage.load_aoi(spec.aoi_id)

    def r(name):
        return storage.load_raster(spec.aoi_id, name)

    base = interventions.SolverInputs(
        dem=r("dem"), manning=r("manning"), infiltration_mm_h=r("infiltration_mm_h"),
        drain_sink_mm_h=r("drain_sink_mm_h"), tide_level_m=None,
        boundary_mask=r("boundary_mask") > 0.5, dx_m=aoi.grid.dx_m, dy_m=aoi.grid.dy_m,
        exclude_mask=r("exclude_mask") > 0.5, inflows=_inflows(spec.aoi_id, aoi) or None,
    )
    return aoi, interventions.apply(spec, aoi.grid, base)


def _inflows(aoi_id: str, aoi) -> list[interventions.Inflow]:
    """Optional `inflows` layer (inland AOIs: river gauges, see pipeline/inflows.py) -> solver sources."""
    if "inflows" not in aoi.layers:
        return []
    out = []
    for src in json.loads(storage.load_aoi_file(aoi_id, "inflows"))["sources"]:
        rc = np.asarray(src["cells"], np.int64).reshape(-1, 2)
        t, q = np.asarray(src["hydrograph"], np.float64).T
        out.append(interventions.Inflow(rc[:, 0] * aoi.grid.nx + rc[:, 1],
                                        lambda s, t=t, q=q: float(np.interp(s, t, q))))  # holds the ends
    return out


def validate(spec: ScenarioSpec) -> None:
    """Cheap checks before any run is created (raises ValueError -> HTTP 400 / tool error)."""
    aoi = storage.load_aoi(spec.aoi_id)
    interventions.validate_areas(spec, aoi.grid)
    if spec.domain == "rain_area":
        if "inflows" in aoi.layers:
            raise ValueError("domain rain_area is not available on a river AOI: the river comes from outside")
        interventions.rain_window(spec, aoi.grid)


def run_scenario(spec: ScenarioSpec, force: bool = False) -> RunManifest:
    validate(spec)
    run_id = spec.run_id()
    with _INFLIGHT_GUARD:
        lock = _INFLIGHT.setdefault(run_id, threading.Lock())
    try:
        with lock:  # a second caller for the same run_id waits here, then hits the cache
            if not force and storage.run_exists(run_id):
                cached = storage.load_run(run_id)
                if cached.status == RunStatus.done:
                    return cached
            with _SOLVE:
                return _solve(spec, run_id)
    finally:
        with _INFLIGHT_GUARD:
            _INFLIGHT.pop(run_id, None)


def _solve(spec: ScenarioSpec, run_id: str) -> RunManifest:
    t0 = time.time()
    simulate, backend_name = _backend()
    storage.save_run(RunManifest(run_id=run_id, scenario=spec, status=RunStatus.running, backend=backend_name))
    try:  # EVERYTHING after the running manifest: a failure must never leave a run stuck in "running"
        return _solve_inner(spec, run_id, simulate, backend_name, t0)
    except jobs.Cancelled:  # every viewer left: no failed manifest, the run stays re-runnable
        raise
    except Exception as exc:  # noqa: BLE001 - surface any failure to the UI/agent
        m = RunManifest(run_id=run_id, scenario=spec, status=RunStatus.failed, error=repr(exc),
                        backend=backend_name)
        storage.save_run(m)
        return m


def _simulate_window(simulate, inp, spec, grid):
    """domain rain_area: solve the rain window only, then pad every frame back to the full grid. Outside the
    window the state is the t=0 one (dry land, boundary water at the default level), so it adds nothing to the
    stored-volume change."""
    win = interventions.rain_window(spec, grid)
    frames, ledger = simulate(interventions.crop(inp, win, (grid.ny, grid.nx)), spec, grid.cell_size_m)
    full0 = np.zeros((grid.ny, grid.nx), frames[0][1].dtype)
    if inp.boundary_mask is not None:
        from dryrun.sim.solver import DEFAULT_TIDE_M

        level = DEFAULT_TIDE_M if inp.tide_level_m is None else inp.tide_level_m
        full0 = np.where(inp.boundary_mask, np.maximum(level - inp.dem, 0), 0).astype(frames[0][1].dtype)
    out = []
    for t, d in frames:
        f = full0.copy()
        f[win] = d
        out.append((t, f))
    ledger["domain_cells"] = int((win[0].stop - win[0].start) * (win[1].stop - win[1].start))
    return out, ledger, win


def _solve_inner(spec, run_id, simulate, backend_name, t0) -> RunManifest:
    aoi, inp = _load_inputs(spec)
    if spec.domain == "rain_area":
        frames, ledger, win = _simulate_window(simulate, inp, spec, aoi.grid)
    else:
        frames, ledger = simulate(inp, spec, aoi.grid.cell_size_m)
        ledger["domain_cells"] = aoi.grid.nx * aoi.grid.ny
        win = None
    domain_cells = ledger.pop("domain_cells")
    if frames[-1][0] != interventions.t_end_s(spec):
        raise RuntimeError("backend must end on the final state")

    excl = inp.exclude_mask
    ponds = interventions.pond_mask(spec, aoi.grid, storage.load_raster(spec.aoi_id, "exclude_mask") > 0.5)
    area = aoi.grid.dx_m * aoi.grid.dy_m
    refs, jobs = [], []
    max_depth = np.zeros_like(frames[0][1])
    ts = {"t_s": [], "flooded_area_km2": [], "road_km_impassable": [], "edges_cut": []}
    for i, (t_s, d) in enumerate(frames):
        png, npy = f"frames/f_{i:04d}.png", f"frames/d_{i:04d}.npy"
        jobs.append(_IO.submit(storage.write_run_file, run_id, png, depth_png(d, excl), "image/png"))
        jobs.append(_IO.submit(storage.write_run_file, run_id, npy, _npy16(d), "application/octet-stream"))
        refs.append(FrameRef(t_s=t_s, png=png, depth=npy))
        max_depth = np.maximum(max_depth, d)
        cut = exposure.cut_mask(spec.aoi_id, d, excl, ponds)
        ts["t_s"].append(t_s)
        ts["flooded_area_km2"].append(round(float(((d >= exposure.FLOODED_M) & ~excl).sum() * area / 1e6), 4))
        ts["road_km_impassable"].append(round(exposure.road_km_cut(spec.aoi_id, cut), 3))
        ts["edges_cut"].append(int(cut.sum()))
    peak_t = ts["t_s"][int(np.argmax(ts["flooded_area_km2"]))]
    jobs.append(_IO.submit(storage.write_run_file, run_id, "max_depth.png", depth_png(max_depth, excl),
                           "image/png"))
    jobs.append(_IO.submit(storage.write_run_file, run_id, "max_depth.npy", _npy16(max_depth),
                           "application/octet-stream"))
    ids, bc = exposure.building_cells(spec.aoi_id)
    bmax = exposure.neighbourhood_max(np.where(excl, 0.0, max_depth))
    bdep = np.round(bmax[bc[:, 0], bc[:, 1]].astype(np.float64), 2).tolist() if len(bc) else []
    if win is not None and len(bc):  # outside the simulated window: not modelled (null), not dry
        inside = ((bc[:, 0] >= win[0].start) & (bc[:, 0] < win[0].stop)
                  & (bc[:, 1] >= win[1].start) & (bc[:, 1] < win[1].stop))
        bdep = [d if ok else None for d, ok in zip(bdep, inside.tolist())]
    jobs.append(_IO.submit(storage.write_run_file, run_id, "building_depths.json",
                           json.dumps({"ids": ids, "max_depth_m": bdep}).encode(), "application/json"))
    for j in jobs:
        j.result()  # surface upload errors before the manifest says "done"

    # Storage GAINED since t=0. Land starts dry; the solver's boundary cells start (and stay) at the
    # tide level, which is the sea, not stored flood water. For the fake both terms start at 0.
    stored_end = float(frames[-1][1].astype(np.float64).sum() - frames[0][1].astype(np.float64).sum()) * area
    rain = ledger["rain_volume_m3"]
    supplied = rain + ledger.get("inflow_volume_m3", 0.0)  # the fake backend has no inflow key
    err = (supplied - ledger["drained_volume_m3"] - ledger["infiltrated_volume_m3"]
           - ledger["boundary_outflow_m3"] - stored_end)
    stats = RunStats(
        run_id=run_id, peak_t_s=peak_t, stored_volume_end_m3=round(stored_end, 1),
        mass_balance_error_pct=round(100 * err / supplied, 4) if supplied else 0.0,
        **{k: round(v, 1) for k, v in ledger.items()}, domain_cells=domain_cells,
        domain_bbox=None if win is None else interventions.window_bbox(win, aoi.grid),
        **exposure.impact(spec.aoi_id, max_depth, area, excl, ponds),
    )
    m = RunManifest(
        run_id=run_id, scenario=spec, status=RunStatus.done, frames=refs, max_depth_png="max_depth.png",
        building_depths="building_depths.json", intervention_cells=inp.intervention_cells or [],
        timeseries=Timeseries(**ts), stats=stats, backend=backend_name, elapsed_s=round(time.time() - t0, 2),
    )
    storage.save_run(m)
    return m


def area_stats(run_id: str, place: str) -> dict:
    """Stats inside one named place (get_area_stats tool + 'area:<place>:<stat>' claims)."""
    m = storage.load_run(run_id)
    if m.stats is None:
        raise ValueError(f"run {run_id} is {m.status.value}")
    aoi, inp = _load_inputs(m.scenario)
    region = interventions.polygon_mask(aoi.grid, interventions.place_polygon(aoi.aoi_id, place))
    max_depth = storage.load_depth(run_id, "max_depth.npy")
    ponds = interventions.pond_mask(m.scenario, aoi.grid, storage.load_raster(aoi.aoi_id, "exclude_mask") > 0.5)
    s = exposure.impact(aoi.aoi_id, max_depth, aoi.grid.dx_m * aoi.grid.dy_m, inp.exclude_mask, ponds, region)
    keys = ("buildings_flooded", "buildings_flooded_own_cell", "people_exposed", "road_km_impassable", "max_depth_m",
            "flooded_area_km2")
    return {"run_id": run_id, "place": place, **{k: s[k] for k in keys}}
