"""REAL backend: 2D local-inertial shallow-water solver (owner: Eng A).

Same signature and return shape as fake.simulate, so engine.py swaps it in with
DRYRUN_SIM_BACKEND=solver.

Formulation (Bates et al. 2010, as in LISFLOOD-FP), per cell face:
    q_new = (q - g*h_flow*dt*dEta/dx) / (1 + g*dt*n^2*|q| / h_flow^(7/3))
    h_flow = max(eta_i, eta_j) - max(z_i, z_j)        (0 if <= 1e-3 m)
    dt     = alpha * min(dx, dy) / sqrt(g * max(h))    alpha = 0.7, cap at 60 s
Continuity:  dh/dt = (sum of face q in - out)/dx + rain - infiltration - drain_sink
Positivity:  a cell's outgoing fluxes are scaled down so it never sends more water than it
             holds (exactly conservative, so h never goes below 0 and mass balance stays exact).
Boundary:    cells in inp.boundary_mask (open lagoon/sea water, wherever it is) are held at the
             tide level every step, so water flows OUT when the land surface is higher and IN
             when the tide is higher. Domain edges elsewhere are closed walls.
Control volume = land cells (not boundary_mask): rain, infiltration and drains act on land only,
and boundary_outflow_m3 is the net water that crossed from land into the held boundary cells.
Boundary cells start (t=0) and stay at the tide level, so frames show the lagoon full while
land starts dry; the engine balances storage as (end - start).

Two kernels with identical maths: numba (serving / CI, `pip install .[sim]`) and a NumPy
fallback (laptops without numba). The numba kernel is compiled lazily on first use, never at
import (cold starts); call warmup() in the Docker build to fill the on-disk cache.
Set DRYRUN_SOLVER_KERNEL=numpy to force the fallback.

No global mutable state: the engine serialises solves and dedupes in-flight runs; this module
must stay re-entrant for that to hold. The solver is deterministic (serial loops, fixed order).

Acceptance (tests/test_solver.py, written FIRST):
  1. Mass balance |err| < 1% on the fixture AOI for a 120 mm / 3 h storm.
  2. Still water on a flat bed stays still (no spurious flow), also a lake at rest on a bumpy bed.
  3. Dam-break on a 1D strip matches the analytic front speed within 10%.
  4. Every intervention moves impact stats in the expected direction vs. baseline.
  5. 333x333 grid, 6 h simulated, < 60 s on 2 vCPU (Cloud Run size). FT_PERF=1 to run it.
"""

from __future__ import annotations

import math
import os
from functools import lru_cache
from typing import Callable

import numpy as np

from dryrun.contracts import ScenarioSpec
from dryrun.sim.interventions import RAIN_UPDATE_S, SolverInputs, rain_cum_mm, t_end_s

G = 9.81
ALPHA = 0.7  # Courant-type safety factor (Bates et al. 2010 recommend 0.3-0.7)
DT_MAX = 60.0  # s
H_MIN = 1e-3  # m: faces shallower than this carry no flow
DEFAULT_TIDE_M = -0.5  # same default as the fake backend (assumption, see model card)


def simulate(inp: SolverInputs, spec: ScenarioSpec, cell_m: float):
    """Return (frames: list[(t_s, depth_m float32 [ny,nx])], ledger: dict[str, float]).

    ledger keys: rain_volume_m3, drained_volume_m3, infiltrated_volume_m3, boundary_outflow_m3,
                 inflow_volume_m3 (boundary_outflow is NET: negative if a high tide pushes water INTO the domain)
    CONTRACT: frames[0] is t=0; frames[-1] is ALWAYS the final state at t_end, even if t_end is
    not a multiple of output_interval (engine computes mass balance from it).
    Physics uses inp.dx_m / inp.dy_m (lon/lat grid, cells ~30 m); cell_m is unused.
    """
    t_end = t_end_s(spec)
    every = spec.output_interval_min * 60
    out_times = list(range(every, t_end, every)) + [t_end]

    def rain_m(t0: float, t1: float) -> float:
        return (rain_cum_mm(spec, t1) - rain_cum_mm(spec, t0)) / 1000.0

    return integrate(inp, out_times, rain_m)


def integrate(inp: SolverInputs, out_times: list[float], rain_m: Callable[[float, float], float] | None = None,
              h0: np.ndarray | None = None, kernel: str | None = None):
    """Time-march from t=0 and snapshot depth at each of out_times (ascending, last = end).

    rain_m(t0, t1) = rain depth in metres falling in [t0, t1]. h0 = initial land depth (tests).
    Returns frames (t as int when whole seconds) and the ledger, like simulate().
    """
    ny, nx = inp.dem.shape
    dx, dy = float(inp.dx_m), float(inp.dy_m)
    area = dx * dy
    z = np.ascontiguousarray(inp.dem, np.float64)
    n = np.ascontiguousarray(inp.manning, np.float64)
    bnd = (np.zeros((ny, nx), bool) if inp.boundary_mask is None
           else np.ascontiguousarray(inp.boundary_mask, bool))
    level = DEFAULT_TIDE_M if inp.tide_level_m is None else float(inp.tide_level_m)
    target = np.where(bnd, np.maximum(level - z, 0.0), 0.0)
    inf = np.where(bnd, 0.0, np.asarray(inp.infiltration_mm_h, np.float64) / 1000 / 3600)
    snk = np.where(bnd, 0.0, np.asarray(inp.drain_sink_mm_h, np.float64) / 1000 / 3600)
    land = (~bnd).astype(np.float64)
    field = inp.rain
    rs = np.ones((ny, nx)) if field is None else np.ascontiguousarray(field.shape(0.0), np.float64)
    land_rain = float((rs * land).sum())  # rain depth x this x area = rain applied to land
    all_rain = float(rs.sum())
    next_shape = RAIN_UPDATE_S if field is not None and field.moving else math.inf

    h = np.zeros((ny, nx)) if h0 is None else np.array(h0, np.float64)
    h[bnd] = target[bnd]
    qx = np.zeros((ny, nx + 1))  # x-face j sits between columns j-1 and j; outer faces stay 0
    qy = np.zeros((ny + 1, nx))  # y-face i sits between rows i-1 and i (positive = southward)
    work = np.zeros((ny, nx))
    step = _numba_step() if _use_numba(kernel) else _numpy_step
    inflows = inp.inflows or []
    for src in inflows:
        c = np.asarray(src.cells)
        if c.size == 0 or c.min() < 0 or c.max() >= ny * nx:
            raise ValueError("inflow cells must be non-empty flat indices inside the grid")
        if bnd.flat[c].any():
            raise ValueError("inflow cells must not be boundary cells")

    led = dict(rain_volume_m3=0.0, drained_volume_m3=0.0, infiltrated_volume_m3=0.0, boundary_outflow_m3=0.0,
               inflow_volume_m3=0.0)
    if field is not None:
        led.update(rain_generated_m3=0.0, rain_in_aoi_m3=0.0)
    frames: list[tuple[float, np.ndarray]] = [(0, h.astype(np.float32))]
    t, hmax = 0.0, float(h.max())
    for t_out in out_times:
        while t < t_out - 1e-9:
            dt = DT_MAX if hmax <= H_MIN else min(DT_MAX, ALPHA * min(dx, dy) / math.sqrt(G * hmax))
            if t + dt >= t_out - 1e-6:  # land exactly on the output time
                dt = t_out - t
            if t >= next_shape - 1e-9:  # a moving cell: the field for [t, t + RAIN_UPDATE_S)
                rs = np.ascontiguousarray(field.shape(t), np.float64)
                land_rain, all_rain = float((rs * land).sum()), float(rs.sum())
                next_shape += RAIN_UPDATE_S
            if t + dt > next_shape + 1e-9:  # never step across a field change
                dt = next_shape - t
            r = rain_m(t, t + dt) if rain_m is not None else 0.0
            for src in inflows:  # trapezoid volume over the step, spread evenly over the source cells
                vol = 0.5 * (src.discharge_m3s(t) + src.discharge_m3s(t + dt)) * dt
                np.add.at(h.reshape(-1), src.cells, vol / (area * len(src.cells)))
                led["inflow_volume_m3"] += vol
                hmax = max(hmax, float(h.flat[src.cells].max()))
            hmax, d_inf, d_drn, d_out = step(h, qx, qy, z, n, inf, snk, land, bnd, target, work,
                                             dt, dx, dy, r, rs)
            led["rain_volume_m3"] += r * land_rain * area
            if field is not None:
                led["rain_generated_m3"] += r * field.generated_m2
                led["rain_in_aoi_m3"] += r * all_rain * area
            led["infiltrated_volume_m3"] += d_inf * area
            led["drained_volume_m3"] += d_drn * area
            led["boundary_outflow_m3"] += d_out * area
            t += dt
        t = float(t_out)
        frames.append((int(t_out) if float(t_out).is_integer() else t_out, h.astype(np.float32)))
    return frames, led


def warmup() -> None:
    """Compile (and disk-cache) the numba kernel. Run once in the Docker build."""
    z = np.zeros((4, 4), np.float32)
    b = np.zeros((4, 4), bool)
    b[-1] = True
    inp = SolverInputs(z, z + 0.03, z, z, -0.2, b, 30.0, 30.0)
    integrate(inp, [120], lambda a, c: 0.001 * (c - a) / 120, kernel="numba")


# ----------------------------------------------------------------------------- kernels
def _use_numba(kernel: str | None) -> bool:
    kernel = kernel or os.getenv("DRYRUN_SOLVER_KERNEL", "auto")
    if kernel == "numpy":
        return False
    try:
        import numba  # noqa: F401
    except ImportError:
        if kernel == "numba":
            raise
        return False
    return True


def _numpy_step(h, qx, qy, z, n, inf, snk, land, bnd, target, work, dt, dx, dy, rain, rs):
    """One explicit step, vectorised. Same maths and order as _step_loops."""
    eta = z + h
    p = 7.0 / 3.0
    for qf, el, er, zl, zr, nl, nr, d in (
        (qx[:, 1:-1], eta[:, :-1], eta[:, 1:], z[:, :-1], z[:, 1:], n[:, :-1], n[:, 1:], dx),
        (qy[1:-1, :], eta[:-1, :], eta[1:, :], z[:-1, :], z[1:, :], n[:-1, :], n[1:, :], dy),
    ):
        hf = np.maximum(el, er) - np.maximum(zl, zr)
        wet = hf > H_MIN
        hs = np.where(wet, hf, 1.0)
        nf = 0.5 * (nl + nr)
        qn = (qf - G * hs * dt * (er - el) / d) / (1 + G * dt * nf * nf * np.abs(qf) / hs ** p)
        qf[:] = np.where(wet, qn, 0.0)

    # positivity limiter: depth each cell would send through its outgoing faces this step
    out = (np.maximum(qx[:, 1:], 0) + np.maximum(-qx[:, :-1], 0)) * dt / dx \
        + (np.maximum(qy[1:, :], 0) + np.maximum(-qy[:-1, :], 0)) * dt / dy
    work[:] = np.where(out > h, h / np.where(out > 0, out, 1.0), 1.0)
    q = qx[:, 1:-1]
    q[:] = np.where(q > 0, q * work[:, :-1], q * work[:, 1:])
    q = qy[1:-1, :]
    q[:] = np.where(q > 0, q * work[:-1, :], q * work[1:, :])

    # continuity, then sources on land, then the held boundary
    v = h + (qx[:, :-1] - qx[:, 1:]) * dt / dx + (qy[:-1, :] - qy[1:, :]) * dt / dy
    v = np.maximum(v, 0.0) + rain * rs * land  # max(): only fp round-off can go negative after the limiter
    a = np.minimum(v, inf * dt)
    v -= a
    b = np.minimum(v, snk * dt)
    v -= b
    d_out = float((v[bnd] - target[bnd]).sum())
    v[bnd] = target[bnd]
    h[:] = v
    return float(h.max()), float(a.sum()), float(b.sum()), d_out


def _step_loops(h, qx, qy, z, n, inf, snk, land, bnd, target, work, dt, dx, dy, rain, rs):
    """Same step as _numpy_step, written as loops for numba."""
    ny, nx = h.shape
    p = 7.0 / 3.0
    for i in range(ny):
        for j in range(1, nx):
            el = z[i, j - 1] + h[i, j - 1]
            er = z[i, j] + h[i, j]
            hf = max(el, er) - max(z[i, j - 1], z[i, j])
            if hf > H_MIN:
                nf = 0.5 * (n[i, j - 1] + n[i, j])
                q = qx[i, j]
                qx[i, j] = (q - G * hf * dt * (er - el) / dx) / (1 + G * dt * nf * nf * abs(q) / hf ** p)
            else:
                qx[i, j] = 0.0
    for i in range(1, ny):
        for j in range(nx):
            el = z[i - 1, j] + h[i - 1, j]
            er = z[i, j] + h[i, j]
            hf = max(el, er) - max(z[i - 1, j], z[i, j])
            if hf > H_MIN:
                nf = 0.5 * (n[i - 1, j] + n[i, j])
                q = qy[i, j]
                qy[i, j] = (q - G * hf * dt * (er - el) / dy) / (1 + G * dt * nf * nf * abs(q) / hf ** p)
            else:
                qy[i, j] = 0.0
    for i in range(ny):
        for j in range(nx):
            out = (max(qx[i, j + 1], 0.0) + max(-qx[i, j], 0.0)) * dt / dx \
                + (max(qy[i + 1, j], 0.0) + max(-qy[i, j], 0.0)) * dt / dy
            work[i, j] = h[i, j] / out if out > h[i, j] else 1.0
    for i in range(ny):
        for j in range(1, nx):
            q = qx[i, j]
            qx[i, j] = q * work[i, j - 1] if q > 0 else q * work[i, j]
    for i in range(1, ny):
        for j in range(nx):
            q = qy[i, j]
            qy[i, j] = q * work[i - 1, j] if q > 0 else q * work[i, j]
    hmax, s_inf, s_drn, s_out = 0.0, 0.0, 0.0, 0.0
    for i in range(ny):
        for j in range(nx):
            v = h[i, j] + (qx[i, j] - qx[i, j + 1]) * dt / dx + (qy[i, j] - qy[i + 1, j]) * dt / dy
            v = max(v, 0.0) + rain * rs[i, j] * land[i, j]
            a = min(v, inf[i, j] * dt)
            v -= a
            b = min(v, snk[i, j] * dt)
            v -= b
            s_inf += a
            s_drn += b
            if bnd[i, j]:
                s_out += v - target[i, j]
                v = target[i, j]
            h[i, j] = v
            hmax = max(hmax, v)
    return hmax, s_inf, s_drn, s_out


@lru_cache(maxsize=1)
def _numba_step():
    import numba

    try:
        return numba.njit(cache=True, nogil=True)(_step_loops)
    except RuntimeError as exc:  # no writable cache dir (read-only /app, no NUMBA_CACHE_DIR): compile every start
        if "cannot cache" not in str(exc):
            raise
        return numba.njit(nogil=True)(_step_loops)
