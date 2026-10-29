"""Demo scenarios (demo.json): pre-warmed into the run cache by scripts/warm_cache.py and offered to the
agent as presets, so one file keeps the warmed specs and the agent's presets identical."""

import copy
import json
from functools import lru_cache
from importlib.resources import files


@lru_cache(maxsize=1)
def demo() -> dict:
    return json.loads(files(__name__).joinpath("demo.json").read_text())


def scenarios(aoi_id: str) -> list[dict]:
    """Preset ScenarioSpecs for one AOI, verbatim (a verbatim copy has the warmed run_id)."""
    return [copy.deepcopy(s) for s in demo()["scenarios"] if s["aoi_id"] == aoi_id]
