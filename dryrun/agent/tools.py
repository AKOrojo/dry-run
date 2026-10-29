"""Agent tool surface (owner: Eng C). Each tool wraps a backend function owned by
someone else; Eng C owns only the schemas, descriptions and dispatch.

Rule: tool results are the ONLY source of numbers the agent may cite.

Tool parameter schemas are HAND-FLATTENED (no $ref/$defs, prefixItems, discriminator, const):
OpenAI-compatible endpoints commonly reject those. Pydantic re-validates on dispatch, so
the flat schema only has to be permissive enough; the contract stays strict.
"""

from __future__ import annotations

import hashlib
import json
import re

from dryrun import storage
from dryrun.contracts import COMPARE_FIELDS, CompareResult, RouteRequest, RunStats, ScenarioSpec
from dryrun.routing.evac import route
from dryrun.sim.engine import area_stats, run_scenario, validate

_LONLAT = {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2,
           "description": "[lon, lat] in degrees"}
_POLY = {"type": "array", "items": _LONLAT, "minItems": 3, "description": "polygon ring of [lon, lat]"}
_INTERVENTION = {
    "type": "object",
    "description": ("One intervention. Area = `place` (a name from get_aoi_info, preferred) OR `polygon`. "
                    "drain_upgrade{capacity_factor?, add_mm_h?, place|polygon? (none = whole area)}; "
                    "green{place|polygon, infiltration_mm_h?, manning?}; pond{place|polygon, depth_m?}; "
                    "tide{boundary_level_m}; road_closure{place|polygon}"),
    "properties": {
        "type": {"type": "string", "enum": ["drain_upgrade", "green", "pond", "tide", "road_closure"]},
        "place": {"type": "string", "description": "name of a place from get_aoi_info"},
        "capacity_factor": {"type": "number", "description": "multiplies EXISTING drains: 1.4 = +40%"},
        "add_mm_h": {"type": "number", "description": "NEW drainage (mm/h) inside the area, where none is mapped"},
        "polygon": _POLY,
        "infiltration_mm_h": {"type": "number"},
        "manning": {"type": "number"},
        "depth_m": {"type": "number"},
        "boundary_level_m": {"type": "number"},
    },
    "required": ["type"],
}
_SCENARIO = {
    "type": "object",
    "properties": {
        "aoi_id": {"type": "string"},
        "storm": {"type": "object", "properties": {
            "total_mm": {"type": "number"}, "duration_h": {"type": "number"},
            "pattern": {"type": "string", "enum": ["uniform", "front_loaded", "center_peaked"]}},
            "required": ["total_mm", "duration_h"]},
        "interventions": {"type": "array", "items": _INTERVENTION},
        "sim_hours": {"type": "number", "description": "default 6, max 12"},
        "label": {"type": "string", "description": "short human label, e.g. 'drains +40%'"},
    },
    "required": ["aoi_id", "storm"],
}

MAX_RUNS_PER_SESSION = 4  # warm prod solver runs take ~35 s; 4 + model turns fit SESSION_DEADLINE_S

TOOL_SPECS = [
    {"type": "function", "function": {
        "name": "get_aoi_info",
        "description": "Geography of the study area: aoi_id, bounds, named neighbourhoods/corridors/low areas "
                       "with polygons you can reuse for interventions, and shelters. Call this FIRST.",
        "parameters": {"type": "object", "properties": {"aoi_id": {"type": "string"}}, "required": ["aoi_id"]}}},
    {"type": "function", "function": {
        "name": "run_simulation",
        "description": "Run the flood solver for a scenario. Returns run_id and impact stats. "
                       f"Cached: identical scenarios return instantly. Budget: max {MAX_RUNS_PER_SESSION} runs per session; "
                       "screen combinations with surrogate_sweep first.",
        "parameters": _SCENARIO}},
    {"type": "function", "function": {
        "name": "get_run_stats", "description": "Fetch impact stats for an existing run_id.",
        "parameters": {"type": "object", "properties": {"run_id": {"type": "string"}}, "required": ["run_id"]}}},
    {"type": "function", "function": {
        "name": "get_area_stats",
        "description": "Impact stats INSIDE one named place for a run (buildings_flooded, buildings_flooded_own_cell, "
                       "people_exposed, road_km_impassable, max_depth_m, flooded_area_km2). "
                       "Cite as field 'area:<place>:<stat>'.",
        "parameters": {"type": "object", "properties": {
            "run_id": {"type": "string"}, "place": {"type": "string"}}, "required": ["run_id", "place"]}}},
    {"type": "function", "function": {
        "name": "compare_runs", "description": "Difference (alt - base) of key impact stats between two runs.",
        "parameters": {"type": "object", "properties": {
            "base_run_id": {"type": "string"}, "alt_run_id": {"type": "string"}},
            "required": ["base_run_id", "alt_run_id"]}}},
    {"type": "function", "function": {
        "name": "compute_route",
        "description": "Flood-aware evacuation route at time t_s (seconds since storm start) in a run. "
                       "Omit destination to route to the nearest shelter. Returns route_id for citing.",
        "parameters": {"type": "object", "properties": {
            "run_id": {"type": "string"}, "t_s": {"type": "integer"},
            "origin": _LONLAT, "destination": _LONLAT}, "required": ["run_id", "t_s", "origin"]}}},
    {"type": "function", "function": {
        "name": "surrogate_sweep",
        "description": "FAST SCREENING with an ML emulator of the solver (is_surrogate=True): ranks combinations "
                       "of drain upgrades, green infrastructure and a pond for one storm. Its numbers are "
                       "predictions with no run_id and CANNOT be cited. Pick a candidate, then confirm it with "
                       "run_simulation using its `interventions` verbatim and cite that run. Does not use run budget.",
        "parameters": {"type": "object", "properties": {
            "aoi_id": {"type": "string"},
            "total_mm": {"type": "number"}, "duration_h": {"type": "number"},
            "tide_m": {"type": "number", "description": "boundary water level; omit for the default"},
            "objective": {"type": "string", "enum": ["buildings_flooded", "buildings_flooded_severe",
                                                     "people_exposed", "road_km_impassable", "flooded_area_km2"]},
            "top_k": {"type": "integer", "description": "candidates to return, max 10 (default 5)"}},
            "required": ["aoi_id", "total_mm", "duration_h"]}}},
]

_LABEL_JUNK = re.compile(r"[^\w .,+%()/×-]")


class Session:
    """Per-agent-session guard: run budget (cost + abuse control on the public URL)."""

    def __init__(self):
        self.runs = 0


def _strip_none(x):
    """Models often send null for unused keys of the flat schema; the strict contract forbids them."""
    if isinstance(x, dict):
        return {k: _strip_none(v) for k, v in x.items() if v is not None}
    if isinstance(x, list):
        return [_strip_none(v) for v in x]
    return x


def aoi_info(aoi_id: str) -> dict:
    m = storage.load_aoi(aoi_id)
    out = {"aoi_id": aoi_id, "name": m.name, "bounds_wgs84": m.grid.bounds_wgs84,
           "is_synthetic": m.is_synthetic, "places": [], "shelters": []}
    if "places" in m.layers:
        for f in json.loads(storage.load_aoi_file(aoi_id, "places"))["features"]:
            if f["geometry"]["type"] != "Polygon":
                continue  # contract: Polygon only
            ring = f["geometry"]["coordinates"][0]
            xs, ys = [p[0] for p in ring], [p[1] for p in ring]
            out["places"].append({"name": f["properties"]["name"], "kind": f["properties"].get("kind"),
                                  "centroid": [round(sum(xs) / len(xs), 5), round(sum(ys) / len(ys), 5)]})
    for f in json.loads(storage.load_aoi_file(aoi_id, "shelters"))["features"]:
        out["shelters"].append({"name": f["properties"]["name"], "lonlat": f["geometry"]["coordinates"]})
    return out


def _cached(spec: ScenarioSpec) -> bool:
    rid = spec.run_id()
    return storage.run_exists(rid) and storage.load_run(rid).status.value == "done"


def _stats(run_id: str) -> RunStats:
    m = storage.load_run(run_id)
    if m.stats is None:
        raise ValueError(f"run {run_id} has no stats (status={m.status}, error={m.error})")
    return m.stats


def dispatch(name: str, args_json: str, session: Session | None = None) -> dict:
    args = _strip_none(json.loads(args_json or "{}"))
    if name == "get_aoi_info":
        return aoi_info(args["aoi_id"])
    if name == "run_simulation":
        if isinstance(args.get("label"), str):  # model labels: tidy to the contract instead of failing the call
            args["label"] = " ".join(_LABEL_JUNK.sub(" ", args["label"]).split())[:60] or None
        spec = ScenarioSpec.model_validate(args)  # validate BEFORE spending budget
        validate(spec)  # unknown AOI / unknown place -> error without spending budget
        if session is not None and not _cached(spec):  # cache hits are instant and free: no budget
            if session.runs >= MAX_RUNS_PER_SESSION:
                return {"error": f"run budget of {MAX_RUNS_PER_SESSION} reached; answer with existing runs"}
            session.runs += 1
        m = run_scenario(spec)
        out = {"run_id": m.run_id, "status": m.status.value, "backend": m.backend,
               "stats": m.stats.model_dump(mode="json") if m.stats else None, "error": m.error}
        warnings = []
        dead = [i for i, n in enumerate(m.intervention_cells) if n == 0]
        if dead:
            warnings.append(f"interventions {dead} changed NO grid cells (outside the AOI, smaller than a cell, "
                            "or no existing drains to multiply: use add_mm_h) and had no effect")
        if m.stats and m.stats.buildings_in_ponds > 0:
            warnings.append(f"ponds cover {m.stats.buildings_in_ponds} buildings: that displaces people, it is not "
                            "a flood reduction. Put ponds on open land or drop them.")
        if warnings:
            out["warning"] = " ".join(warnings)
        return out
    if name == "get_area_stats":
        return area_stats(args["run_id"], args["place"])
    if name == "get_run_stats":
        return _stats(args["run_id"]).model_dump()
    if name == "compare_runs":
        a, b = _stats(args["base_run_id"]), _stats(args["alt_run_id"])
        da, db = a.model_dump(), b.model_dump()
        delta = {k: round(db[k] - da[k], 4) for k in COMPARE_FIELDS}
        return CompareResult(base_run_id=a.run_id, alt_run_id=b.run_id, delta=delta).model_dump()
    if name == "compute_route":
        req = RouteRequest.model_validate(args)
        res = route(req).model_dump()
        # Persist PRIVATELY (contains user-chosen coordinates) so route numbers are verifiable:
        # claim.field = "route:<route_id>:eta_min"
        route_id = "rt_" + hashlib.sha256(req.model_dump_json().encode()).hexdigest()[:12]
        storage.write_private(f"routes/{req.run_id}/{route_id}.json", json.dumps(res).encode())
        return {"route_id": route_id, **res}
    if name == "surrogate_sweep":
        from dryrun.surrogate.sweep import surrogate_sweep  # Eng A

        keys = ("aoi_id", "total_mm", "duration_h", "tide_m", "objective", "top_k")
        return surrogate_sweep(**{k: args[k] for k in keys if k in args})
    raise KeyError(f"unknown tool {name}")
