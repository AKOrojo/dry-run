"""Pre-compute demo scenarios so the live demo never waits on the solver. Run against prod storage:
   DRYRUN_STORAGE=gcs DRYRUN_SIM_BACKEND=solver ... python scripts/warm_cache.py
"""
from dryrun import presets
from dryrun.contracts import ScenarioSpec
from dryrun.sim.engine import run_scenario

for s in presets.demo()["scenarios"]:
    m = run_scenario(ScenarioSpec.model_validate(s))
    print(f"{m.status.value:6} {m.run_id} {s['label']}  ({m.elapsed_s}s, backend={m.backend})")
