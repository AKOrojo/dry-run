"""End-to-end smoke test without network: fixtures -> runs -> route -> agent brief.

Everyone runs `make smoke` before pushing to main. CI runs it too.
"""

import os

os.environ["DRYRUN_STORAGE"] = "local"  # never let smoke touch real buckets (even if .env says gcs)
os.environ["DRYRUN_SIM_BACKEND"] = os.getenv("SMOKE_SIM_BACKEND", "fake")

from dryrun.agent.loop import run as agent_run  # noqa: E402
from dryrun.contracts import DrainUpgrade, RouteRequest, ScenarioSpec, Storm  # noqa: E402
from dryrun.pipeline import fixtures  # noqa: E402
from dryrun.routing.evac import route  # noqa: E402
from dryrun.sim.engine import run_scenario  # noqa: E402

fixtures.build()
storm = Storm(total_mm=120, duration_h=3)
base = run_scenario(ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=storm))
alt = run_scenario(ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=storm,
                                interventions=[DrainUpgrade(capacity_factor=3.0)]))
assert base.status == "done" and alt.status == "done", (base.error, alt.error)
assert abs(base.stats.mass_balance_error_pct) < 1.0, base.stats.mass_balance_error_pct
assert alt.stats.road_km_impassable <= base.stats.road_km_impassable
r = route(RouteRequest(run_id=base.run_id, t_s=base.stats.peak_t_s, origin=(3.50, 6.445)))
events = list(agent_run("Does tripling drain capacity help?", "fake"))
brief = next(e for e in events if e.kind == "brief").data
assert all(c["verified"] for c in brief["claims"]), brief["claims"]
assert not brief["prose_has_digits"]
print(f"OK  base={base.run_id} alt={alt.run_id}  route reachable={r.reachable} "
      f"eta={r.eta_min}min  claims verified={len(brief['claims'])}")
