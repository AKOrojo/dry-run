"""Scenario-planner agent loop (owner: Eng C).

plan/act with tools until the model stops calling them (or MAX_STEPS), then ask
for a structured Brief, then verify every claim against stored stats.
Yields AgentEvents so the API can stream them to the UI over SSE.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Iterator

import httpx

from dryrun.agent import tools, verify
from dryrun.api.errors import classify_llm_error
from dryrun.contracts import AgentEvent, Brief
from dryrun.meta.providers import get_provider

MAX_STEPS = 12
MAX_CALLS_PER_TURN = 6
MAX_TOOL_CALLS = 24
BRIEF_MAX_TOKENS = 12000
SESSION_DEADLINE_S = 240  # well under the 900 s Cloud Run request timeout

log = logging.getLogger(__name__)

SYSTEM = """You are Dry Run's scenario planner for flooding in the study area below.
You can ONLY learn numbers by calling tools. Never estimate, never recall figures.
Work like an engineer: run a baseline first, then test interventions one change at a
time, compare against the baseline, and check evacuation routes where relevant.
Interventions available: drain_upgrade (capacity_factor multiplies existing drains, add_mm_h adds new
drainage inside a polygon), green, pond (draw on open land, not on buildings), tide, road_closure.
drain_upgrade with no place or polygon applies to the WHOLE study area: describe add_mm_h there as
city-wide new drainage, never as a local fix.
Leave storm pattern, sim_hours and output_interval_min at their defaults unless the user asks for them.
Study area: {aoi_id}. Call get_aoi_info first and reuse its place polygons; never invent coordinates.
If get_aoi_info has has_river_inflows, gauged river inflows are built into every run and cannot be changed;
tide is for coastal areas only: there get_aoi_info has a "tide" entry, whose levels are assumptions, not forecasts;
say so when you use one. Rain falls over the whole study area unless the user asks for localized rain: then set
storm.spatial, a storm cell centred on a get_aoi_info place (kind cell; add a track only for a moving storm) or rain
inside one place (kind polygon). With a cell, total_mm is the depth at its centre and less falls further out; say
so. Rain can only come from storm inputs: never imitate a localized storm with interventions.
get_aoi_info's "presets" are scenarios already run: when one answers part of the question,
pass it to run_simulation verbatim and it returns instantly. Presets are a speed path, not a menu: if the user
asks for a different storm, place or intervention, run exactly what they asked, never the nearest preset.
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
  "area:<place name>:<stat>"             e.g. "area:Lekki Phase 1:buildings_flooded" (from get_area_stats)
Flooded buildings: cite BOTH buildings_flooded ("buildings with flood water close by", within about 45 m) and
buildings_flooded_own_cell ("buildings with water at the building") from the same source; the truth is between them."""

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
    dec, json_err, brief_err = json.JSONDecoder(), None, None
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            data, _ = dec.raw_decode(text, i)
        except ValueError as exc:
            json_err = json_err or exc
            continue
        if isinstance(data, dict) and "claims" in data:
            data.update(model=p.model, provider=p.name)
            try:
                return Brief.model_validate(data)
            except ValueError as exc:  # report THIS, not JSON noise from later braces inside the object
                brief_err = brief_err or exc
    raise ValueError(f"no valid brief JSON found ({brief_err or json_err})")


def _error_event(stage: str, exc: BaseException) -> AgentEvent:
    # Full exception to the server log only; the client gets a stable code and a safe sentence.
    log.warning("agent %s error: %r", stage, exc)
    info = classify_llm_error(exc, stage)
    return AgentEvent(kind="error", data={"stage": stage, **info, "error": info["message"]})


def run(question: str, provider_name: str = "meta", aoi_id: str | None = None) -> Iterator[AgentEvent]:
    try:
        p = get_provider(provider_name)
    except Exception as exc:  # noqa: BLE001 - e.g. key not configured: tell the UI instead of a dead stream
        yield _error_event("provider", exc)
        yield AgentEvent(kind="done", data={})
        return
    session = tools.Session()
    aoi_id = aoi_id or os.getenv("DRYRUN_DEFAULT_AOI", "fixture-synthetic")
    start = time.time()
    deadline = start + SESSION_DEADLINE_S
    dispatched = 0
    msgs: list[dict] = [{"role": "system", "content": SYSTEM.format(aoi_id=aoi_id)},
                        {"role": "user", "content": question}]
    for _ in range(MAX_STEPS):
        if time.time() > deadline:
            yield AgentEvent(kind="thought", data={"text": "Time budget reached; writing the brief."})
            break
        try:
            turn = p.chat(msgs, tools=tools.TOOL_SPECS)
        except Exception as exc:  # noqa: BLE001 - provider HTTP errors/timeouts -> UI error event
            yield _error_event("chat", exc)
            yield AgentEvent(kind="done", data={})
            return
        if turn.content:
            yield AgentEvent(kind="thought", data={"text": turn.content})
        if not turn.tool_calls:
            break
        msgs.append({"role": "assistant", "content": turn.content, "tool_calls": [
            {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
            for c in turn.tool_calls]})
        timed_out = False
        for i, c in enumerate(turn.tool_calls):  # Muse Spark may return several in parallel
            try:
                shown = json.loads(c.arguments or "{}")
            except ValueError:
                shown = {"_unparsed": c.arguments}
            yield AgentEvent(kind="tool_call", data={"name": c.name, "arguments": shown})
            timed_out = timed_out or time.time() > deadline
            if timed_out:
                result = {"error": "Time budget reached; answer with existing results"}
            elif dispatched >= MAX_TOOL_CALLS:
                result = {"error": "Tool budget reached; answer with existing results"}
            elif i >= MAX_CALLS_PER_TURN:
                result = {"error": "Turn tool budget reached; answer with existing results"}
            else:
                dispatched += 1
                try:
                    result = tools.dispatch(c.name, c.arguments, session)
                except Exception as exc:  # noqa: BLE001 - feed errors back so the model can recover
                    result = {"error": repr(exc)}
            budget = {"runs_used": session.runs, "runs_max": tools.MAX_RUNS_PER_SESSION,
                      "elapsed_s": round(time.time() - start, 1), "deadline_s": SESSION_DEADLINE_S}
            yield AgentEvent(kind="tool_result", data={"name": c.name, "result": result, "budget": budget})
            if c.name == "run_simulation" and result.get("status") == "done":
                yield AgentEvent(kind="run_ready", data={"run_id": result["run_id"]})
            msgs.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(result)})
        if timed_out or dispatched >= MAX_TOOL_CALLS:
            text = "Time budget reached" if timed_out else "Tool budget reached"
            yield AgentEvent(kind="thought", data={"text": f"{text}; writing the brief."})
            break

    msgs.append({"role": "user", "content": BRIEF_INSTRUCTIONS})
    schema = {"type": "json_schema", "json_schema": {"name": "brief", "schema": BRIEF_SCHEMA}}
    brief, err = None, None
    last_exc: Exception | None = None
    for attempt in range(2):  # one retry with the validation error fed back
        if attempt and time.time() > deadline + 60:
            break
        try:
            # Reasoning models spend much of max_tokens thinking; 4000 truncated long briefs mid-JSON.
            turn = p.chat(msgs, response_format=schema if attempt == 0 else None, max_tokens=BRIEF_MAX_TOKENS)
            brief = _parse_brief(turn.content or "", p)
            break
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            err = f"attempt {attempt + 1}: {exc!r}" if err is None else f"{err}; attempt {attempt + 1}: {exc!r}"
            msgs.append({"role": "user", "content": f"That was not valid. Error: {err}. Reply with the JSON only."})
    if brief is None:
        log.warning("agent brief error: %s", err)
        if isinstance(last_exc, httpx.HTTPError):
            yield _error_event("brief", last_exc)
        else:  # the model answered, but not with a valid brief
            msg = "The model did not return a valid brief. Try again."
            yield AgentEvent(kind="error", data={"stage": "brief", "code": "llm_bad_response", "retryable": True,
                                                 "message": msg, "error": msg})
    else:
        checked, digits = verify.verify_brief(brief)
        yield AgentEvent(kind="brief", data={**checked.model_dump(), "prose_has_digits": digits})
    yield AgentEvent(kind="done", data={})
