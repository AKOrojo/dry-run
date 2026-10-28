"""REAL backend: 2D local-inertial shallow-water solver (owner: Eng A).

Must have the SAME signature and return shape as fake.simulate so engine.py
can swap it in with DRYRUN_SIM_BACKEND=solver.

Formulation (Bates et al. 2010, as in LISFLOOD-FP), per cell face:
    q_new = (q - g*h_flow*dt*dEta/dx) / (1 + g*dt*n^2*|q| / h_flow^(7/3))
    h_flow = max(eta_i, eta_j) - max(z_i, z_j)        (0 if <= 1e-3 m)
    dt     = alpha * dx / sqrt(g * max(h))             alpha ~= 0.7, cap at 60 s
Continuity:  dh/dt = (sum of face q in - out)/dx + rain - infiltration - drain_sink
Boundary:    cells in inp.boundary_mask (open lagoon/sea water, wherever it is) held at the tide
             level with inflow AND outflow; domain edges elsewhere closed.

Acceptance (tests/test_solver.py, written FIRST):
  1. Mass balance |err| < 1% on the fixture AOI for a 120 mm / 3 h storm.
  2. Still water on a flat bed stays still (no spurious flow).
  3. Dam-break on a 1D strip matches the analytic front speed within 10%.
  4. Every intervention moves impact stats in the expected direction vs. baseline.
  5. 333x333 grid, 6 h simulated, < 60 s on 2 vCPU (Cloud Run size). Use numba.
"""

from __future__ import annotations

from dryrun.contracts import ScenarioSpec
from dryrun.sim.interventions import SolverInputs


def simulate(inp: SolverInputs, spec: ScenarioSpec, cell_m: float):
    """Return (frames: list[(t_s, depth_m float32 [ny,nx])], ledger: dict[str, float]).

    ledger keys: rain_volume_m3, drained_volume_m3, infiltrated_volume_m3, boundary_outflow_m3
                 (boundary_outflow is NET: negative if a high tide pushes water INTO the domain)
    CONTRACT: frames[0] is t=0; frames[-1] is ALWAYS the final state at t_end, even if t_end is
    not a multiple of output_interval (engine computes mass balance from it).
    Use inp.dx_m / inp.dy_m for physics (lon/lat grid, cells ~30 m).
    Tide: unlike the fake backend, model INFLOW when tide level > water surface at the boundary.
    """
    raise NotImplementedError("Eng A: implement local-inertial solver (see docstring)")
