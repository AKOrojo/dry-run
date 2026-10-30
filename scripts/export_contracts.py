"""Export pydantic contracts to JSON Schema (consumed by web/ via json-schema-to-typescript)."""

import json
from pathlib import Path

from dryrun.contracts import schemas as s

OUT = Path("contracts/jsonschema")
OUT.mkdir(parents=True, exist_ok=True)
MODELS = [s.Patch3DRequest, s.Patch3DManifest, s.AOIManifest, s.ScenarioSpec, s.RunManifest, s.RunStats, s.CompareResult,
          s.RouteRequest, s.RouteResult, s.AreaStats, s.Timeseries, s.Observation, s.Brief, s.AgentEvent]


def tuples_draft7(node):
    """pydantic writes tuples as 2020-12 prefixItems, which json-schema-to-typescript types as unknown[]; the
    draft-07 items array gives [number, number]."""
    if isinstance(node, dict):
        if "prefixItems" in node:
            node["items"] = node.pop("prefixItems")
            node.setdefault("additionalItems", False)
        for v in node.values():
            tuples_draft7(v)
    elif isinstance(node, list):
        for v in node:
            tuples_draft7(v)
    return node


for m in MODELS:
    (OUT / f"{m.__name__}.json").write_text(json.dumps(tuples_draft7(m.model_json_schema()), indent=2))
print(f"wrote {len(MODELS)} schemas to {OUT}/ (contract {s.CONTRACT_VERSION})")
