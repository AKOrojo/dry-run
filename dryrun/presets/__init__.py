"""Demo scenarios (demo.json): pre-warmed into the run cache by scripts/warm_cache.py and offered to the
agent as presets, so one file keeps the warmed specs and the agent's presets identical."""

import copy
import json
from functools import lru_cache
from importlib.resources import files


@lru_cache(maxsize=1)
def demo() -> dict:
    return json.loads(files(__name__).joinpath("demo.json").read_text())


def level_sensitivity(aoi_id: str) -> dict | None:
    """Flooded km2 and buildings at several lagoon/sea levels under one reference storm
    (evals/validation/level_sensitivity.py); None where the AOI has no table."""
    return json.loads(files(__name__).joinpath("level_sensitivity.json").read_text()).get(aoi_id)


def scenarios(aoi_id: str) -> list[dict]:
    """Preset ScenarioSpecs for one AOI, verbatim (a verbatim copy has the warmed run_id)."""
    return [copy.deepcopy(s) for s in demo()["scenarios"] if s["aoi_id"] == aoi_id]
