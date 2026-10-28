"""Scenario-planner agent loop (owner: Eng C).

plan/act with tools until the model stops calling them (or MAX_STEPS), then ask
for a structured Brief, then verify every claim against stored stats.
Yields AgentEvents so the API can stream them to the UI over SSE.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Iterator

from dryrun.agent import tools, verify
from dryrun.contracts import AgentEvent, Brief
from dryrun.meta.providers import get_provider

MAX_STEPS = 12
SESSION_DEADLINE_S = 240  # well under the 900 s Cloud Run request timeout

SYSTEM = """You are Dry Run's scenario planner for urban flooding in Lagos.
You can ONLY learn numbers by calling tools. Never estimate, never recall figures.
Work like an engineer: run a baseline first, then test interventions one change at a
time, compare against the baseline, and check evacuation routes where relevant.
Interventions available: drain_upgrade (capacity_factor multiplies existing drains, add_mm_h adds new
drainage inside a polygon), green, pond (draw on open land, not on buildings), tide, road_closure.
Study area: {aoi_id}. Call get_aoi_info first and reuse its place polygons; never invent coordinates.
If a tool result has a "warning", fix the scenario rather than reporting its numbers.
The simulator is a planning model, not a forecast. Do not give medical, political
or blame-assigning commentary. Keep tool calls purposeful; stop when you can answer."""

BRIEF_INSTRUCTIONS = """Write the decision brief now as ONE JSON object, no prose around it:
{"title": str, "summary": str, "claims": [{"text": str, "unit": str, "source_run_id": str,
  "field": str, "model_value": number|null}], "recommended_run_id": str|null}
Rules: NO digits in `title`, `summary` or any claim `text` (write "flooded buildings with drains", not
"227 flooded buildings"). Every number is a claim; leave model_value null and the system fills the
number in from the source you name. `field` is one of:
  "<stat name>"                          e.g. "road_km_impassable" of source_run_id
  "delta:<stat name>:<base_run_id>"      source_run_id minus base run
  "route:<route_id>:<field>"             e.g. "route:rt_ab12:eta_min" (source_run_id = the route's run)
  "area:<place name>:<stat>"             e.g. "area:Lekki Phase 1:buildings_flooded" (from get_area_stats)"""

# Flat schema for providers that support response_format=json_schema (no $refs).
BRIEF_SCHEMA = {"type": "object", "properties": {
    "title": {"type": "string"}, "summary": {"type": "string"},
    "recommended_run_id": {"type": ["string", "null"]},
    "claims": {"type": "array", "items": {"type": "object", "properties": {
        "text": {"type": "string"}, "unit": {"type": "string"}, "source_run_id": {"type": "string"},
        "field": {"type": "string"}, "model_value": {"type": ["number", "null"]}},
        "required": ["text", "unit", "source_run_id", "field"]}}},
    "required": ["title", "summary", "claims"]}


def _parse_brief(text: str, p) -> Brief:
    """Find the first JSON object that validates as a Brief (tolerates reasoning text / code fences)."""
    dec, last_err = json.JSONDecoder(), None
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            data, _ = dec.raw_decode(text, i)
            if isinstance(data, dict) and "claims" in data:
                data.update(model=p.model, provider=p.name)
                return Brief.model_validate(data)
        except ValueError as exc:
            last_err = exc
    raise ValueError(f"no valid brief JSON found ({last_err})")


def run(question: str, provider_name: str = "meta", aoi_id: str | None = None) -> Iterator[AgentEvent]:
    p = get_provider(provider_name)
    session = tools.Session()
    aoi_id = aoi_id or os.getenv("DRYRUN_DEFAULT_AOI", "fixture-synthetic")
    deadline = time.time() + SESSION_DEADLINE_S
    msgs: list[dict] = [{"role": "system", "content": SYSTEM.format(aoi_id=aoi_id)},
                        {"role": "user", "content": question}]
    for _ in range(MAX_STEPS):
        if time.time() > deadline:
            yield AgentEvent(kind="thought", data={"text": "Time budget reached; writing the brief."})
            break
        try:
            turn = p.chat(msgs, tools=tools.TOOL_SPECS)
        except Exception as exc:  # noqa: BLE001 - provider HTTP errors/timeouts -> UI error event
            yield AgentEvent(kind="error", data={"stage": "chat", "error": repr(exc)})
            yield AgentEvent(kind="done", data={})
            return
        if turn.content:
            yield AgentEvent(kind="thought", data={"text": turn.content})
        if not turn.tool_calls:
            break
        msgs.append({"role": "assistant", "content": turn.content, "tool_calls": [
            {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
            for c in turn.tool_calls]})
        for c in turn.tool_calls:  # Muse Spark may return several in parallel
            try:
                shown = json.loads(c.arguments or "{}")
            except ValueError:
                shown = {"_unparsed": c.arguments}
            yield AgentEvent(kind="tool_call", data={"name": c.name, "arguments": shown})
            try:
                result = tools.dispatch(c.name, c.arguments, session)
            except Exception as exc:  # noqa: BLE001 - feed errors back so the model can recover
                result = {"error": repr(exc)}
            yield AgentEvent(kind="tool_result", data={"name": c.name, "result": result})
            if c.name == "run_simulation" and result.get("status") == "done":
                yield AgentEvent(kind="run_ready", data={"run_id": result["run_id"]})
            msgs.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(result)})

    msgs.append({"role": "user", "content": BRIEF_INSTRUCTIONS})
    schema = {"type": "json_schema", "json_schema": {"name": "brief", "schema": BRIEF_SCHEMA}}
    brief, err = None, None
    for attempt in range(2):  # one retry with the validation error fed back
        if attempt and time.time() > deadline + 60:
            break
        try:
            turn = p.chat(msgs, response_format=schema if attempt == 0 else None)
            brief = _parse_brief(turn.content or "", p)
            break
        except Exception as exc:  # noqa: BLE001
            err = f"attempt {attempt + 1}: {exc!r}" if err is None else f"{err}; attempt {attempt + 1}: {exc!r}"
            msgs.append({"role": "user", "content": f"That was not valid. Error: {err}. Reply with the JSON only."})
    if brief is None:
        yield AgentEvent(kind="error", data={"stage": "brief", "error": err})
    else:
        checked, digits = verify.verify_brief(brief)
        yield AgentEvent(kind="brief", data={**checked.model_dump(), "prose_has_digits": digits})
    yield AgentEvent(kind="done", data={})
