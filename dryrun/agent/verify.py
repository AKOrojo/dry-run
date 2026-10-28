"""Fail-closed claim verification (owner: Eng C).

The model names WHERE a number comes from (source_run_id + field); the verifier looks the
number up and writes the TRUE value into `claim.value`. The model's own number is kept in
`model_value`. A claim is `verified` if the lookup succeeds AND either the model gave no number
(preferred: the prompt asks it to cite fields, not numbers) or its number matches (ints exactly,
floats to 2% / 0.05). Unverified claims render greyed with a warning,
and are never silently "fixed" in the prose.

field formats:
  "<RunStats field>"                       value of that run
  "delta:<RunStats field>:<base_run_id>"   this run minus base run
  "route:<route_id>:<RouteResult field>"   a route computed in this session
  "area:<place name>:<AreaStats field>"    stats inside a named place
Numbers are only shown from `value`: a claim whose TEXT contains digits is unverified, and a
title/summary with digits is flagged.
"""

from __future__ import annotations

import json
import re

from dryrun import storage
from dryrun.contracts import Brief, Claim

_DIGITS = re.compile(r"\d")
REL_TOL = 0.02
ABS_TOL = 0.051
INT_FIELDS = {"buildings_flooded", "buildings_flooded_severe", "buildings_in_ponds", "people_exposed", "peak_t_s",
              "edges_removed", "edges_cut"}


def _truth(claim: Claim) -> tuple[float, bool]:
    """Returns (true value, is_integer_field). Raises on any lookup failure."""
    f = claim.field
    if f.startswith("area:"):
        from dryrun.sim.engine import area_stats

        _, place, field = f.split(":", 2)
        return float(area_stats(claim.source_run_id, place)[field]), field in INT_FIELDS
    if f.startswith("route:"):
        _, route_id, field = f.split(":", 2)
        res = json.loads(storage.read_private(f"routes/{claim.source_run_id}/{route_id}.json"))
        return float(res[field]), field in INT_FIELDS
    stats = storage.load_run(claim.source_run_id).stats.model_dump()
    if f.startswith("delta:"):
        _, field, base_id = f.split(":", 2)
        base = storage.load_run(base_id).stats.model_dump()
        return float(stats[field] - base[field]), field in INT_FIELDS
    return float(stats[f]), f in INT_FIELDS


def check(claim: Claim) -> Claim:
    try:
        truth, is_int = _truth(claim)
    except Exception:  # noqa: BLE001 - any lookup failure = unverified, value unknown
        return claim.model_copy(update={"value": None, "verified": False})
    mv = claim.model_value
    ok = mv is None or (
        round(mv) == round(truth) if is_int else abs(mv - truth) <= max(ABS_TOL, REL_TOL * abs(truth)))
    ok = ok and not _DIGITS.search(claim.text)  # numbers may only come from `value`
    return claim.model_copy(update={"value": round(truth, 3), "verified": bool(ok)})


def verify_brief(brief: Brief) -> tuple[Brief, bool]:
    """Returns (brief with checked claims, prose_has_digits). The UI flags title/summary with digits."""
    claims = [check(c) for c in brief.claims]
    return brief.model_copy(update={"claims": claims}), bool(_DIGITS.search(brief.summary + brief.title))
