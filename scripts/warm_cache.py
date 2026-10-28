"""Pre-compute demo scenarios so the live demo never waits on the solver. Run against prod storage:
   DRYRUN_STORAGE=gcs DRYRUN_SIM_BACKEND=solver ... python scripts/warm_cache.py
"""
import json
from pathlib import Path

from dryrun.contracts import ScenarioSpec
from dryrun.sim.engine import run_scenario

for s in json.loads(Path("evals/scenarios/demo.json").read_text())["scenarios"]:
    m = run_scenario(ScenarioSpec.model_validate(s))
    print(f"{m.status.value:6} {m.run_id} {s['label']}  ({m.elapsed_s}s, backend={m.backend})")
