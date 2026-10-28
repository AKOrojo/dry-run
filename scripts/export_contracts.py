"""Export pydantic contracts to JSON Schema (consumed by web/ via json-schema-to-typescript)."""

import json
from pathlib import Path

from dryrun.contracts import schemas as s

OUT = Path("contracts/jsonschema")
OUT.mkdir(parents=True, exist_ok=True)
MODELS = [s.AOIManifest, s.ScenarioSpec, s.RunManifest, s.RunStats, s.CompareResult,
          s.RouteRequest, s.RouteResult, s.AreaStats, s.Timeseries, s.Observation, s.Brief, s.AgentEvent]
for m in MODELS:
    (OUT / f"{m.__name__}.json").write_text(json.dumps(m.model_json_schema(), indent=2))
print(f"wrote {len(MODELS)} schemas to {OUT}/ (contract {s.CONTRACT_VERSION})")
