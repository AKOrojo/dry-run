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
from dryrun.contracts import AreaStats, Brief, Claim, RouteResult, RunStats

_DIGITS = re.compile(r"\d")
REL_TOL = 0.02
ABS_TOL = 0.051
# Which fields compare exactly instead of within tolerance -- DERIVED from the contract, not typed
# out, because the hand-written version had already drifted from it: `t_s` (RouteResult, int) was
# missing, so "route:<id>:t_s" accepted any model number within 2%, and `edges_cut` was listed but
# is a Timeseries field no claim form can reach. Both are silent failures -- a too-loose tolerance
# does not raise, it just verifies a wrong number. Eng A freezes the stat set on Thursday; deriving
# it means their rename or new int lands here automatically instead of waiting to be noticed.
INT_FIELDS = {name for model in (RunStats, RouteResult, AreaStats)
              for name, f in model.model_fields.items() if f.annotation is int}

# `source_run_id` and `field` are MODEL-AUTHORED STRINGS, and three of the lookups below paste them
# into a storage key: routes/<run_id>/<route_id>.json and runs/<run_id>/manifest.json (twice, once
# more for the delta base). storage._read_bytes does no normalisation, so in local mode a field of
# "route:../../../../etc/x:y" is an arbitrary file read whose result lands in claim.value with
# verified=True -- the verifier laundering an attacker's number into a brief as checked truth. That
# is the exact failure this module exists to prevent, so the ids are matched against their
# generators before any lookup: r_<16 hex> (contracts.RunManifest, same regex as api/main.py),
# rt_<12 hex> (tools.py route_id). GCS treats ".." as a literal character in an object name, so
# production fails closed already; the exposure is local/dev mode, which is every laptop running
# `make api`. Validate anyway -- "the other backend happens to be immune" is not an access control.
_RUN_ID = re.compile(r"^r_[0-9a-f]{16}$")
_ROUTE_ID = re.compile(r"^rt_[0-9a-f]{12}$")
_FIELD = re.compile(r"^[a-z][a-z0-9_]{0,39}$")  # a RunStats/RouteResult/AreaStats attribute name
# "North Estate (synthetic)", "Heart O’ the Hills": Unicode letters and curly apostrophes occur in real OSM names.
_PLACE = re.compile(r"^[\w .,'’()\-]{1,80}$")  # a manifest key, never a path


def _safe(pattern: re.Pattern[str], value: str, what: str) -> str:
    """Identity, or raise -> check() converts the raise into verified=False, value=None."""
    if not pattern.match(value):
        raise ValueError(f"unsafe {what}: {value!r}")
    return value


def _truth(claim: Claim) -> tuple[float, bool]:
    """Returns (true value, is_integer_field). Raises on any lookup failure or unsafe identifier."""
    f = claim.field
    run_id = _safe(_RUN_ID, claim.source_run_id, "run id")
    if f.startswith("area:"):
        from dryrun.sim.engine import area_stats

        _, place, field = f.split(":", 2)
        from dryrun.agent.tools import canonical_place

        _safe(_PLACE, place, "place")
        _safe(_FIELD, field, "field")
        place = canonical_place(storage.load_run(run_id).scenario.aoi_id, place)
        return float(area_stats(run_id, place)[field]), field in INT_FIELDS
    if f.startswith("route:"):
        _, route_id, field = f.split(":", 2)
        _safe(_ROUTE_ID, route_id, "route id")
        res = json.loads(storage.read_private(f"routes/{run_id}/{route_id}.json"))
        return float(res[_safe(_FIELD, field, "field")]), field in INT_FIELDS
    stats = storage.load_run(run_id).stats.model_dump()
    if f.startswith("delta:"):
        _, field, base_id = f.split(":", 2)
        base = storage.load_run(_safe(_RUN_ID, base_id, "base run id")).stats.model_dump()
        _safe(_FIELD, field, "field")
        return float(stats[field] - base[field]), field in INT_FIELDS
    return float(stats[_safe(_FIELD, f, "field")]), f in INT_FIELDS


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
