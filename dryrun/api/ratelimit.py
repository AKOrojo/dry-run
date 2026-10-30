"""Tiny per-IP, per-instance rate limiter (owner: Eng D). Protects the public demo URL
from runaway cost (Meta credits are per person; GCP is capped only by max-instances).
Team members bypass it with header X-Team-Token: $DRYRUN_ADMIN_TOKEN (rehearsals, recording).
Paid model calls (Meta, Baseten) need a key: the team token, or X-Judge-Key: $DRYRUN_JUDGE_TOKEN. Judges get
that key through the private submission form, never through the repo (the repo is public).
Every presented key goes through authguard (shared brute-force lockout) before it is compared."""

from __future__ import annotations

import hmac
import os
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from dryrun.api import authguard

_hits: dict[tuple[str, str], deque] = defaultdict(deque)
_TEAM = os.getenv("DRYRUN_ADMIN_TOKEN", "").strip()
if _TEAM == "unset":  # bootstrap placeholder: no bypass
    _TEAM = ""
_JUDGE = os.getenv("DRYRUN_JUDGE_TOKEN", "").strip()
if _JUDGE == "unset":
    _JUDGE = ""


def client_ip(request) -> str:
    # Cloud Run APPENDS the real client IP to X-Forwarded-For; earlier entries are client-controlled.
    xff = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    return xff[-1] if xff else (request.client.host if request.client else "?")


def _matches(given: str, token: str) -> bool:
    """Constant-time compare, so response timing does not leak a token a byte at a time."""
    return bool(token) and hmac.compare_digest(given.encode(), token.encode())


def _verdict(request) -> str:
    """"team" | "judge" | "none" (no key presented) | "wrong". Computed once per request, so a wrong key counts once
    even when several checks run. A presented key is checked against the lockout first (429 while locked, even
    for the right key)."""
    state = getattr(request, "state", None)
    memo = getattr(state if state is not None else request, "_dryrun_auth", None)
    if memo is not None:
        return memo
    team, judge = request.headers.get("x-team-token", ""), request.headers.get("x-judge-key", "")
    if not team and not judge:
        v = "none"
    else:
        ip = client_ip(request)
        authguard.check(ip)
        if team and _matches(team, _TEAM):
            v = "team"
        elif judge and _matches(judge, _JUDGE):
            v = "judge"
        else:
            authguard.record_failure(ip)
            v = "wrong"
    setattr(state if state is not None else request, "_dryrun_auth", v)
    return v


def _is_team(request: Request) -> bool:
    return _verdict(request) == "team"


def paid_access_configured() -> bool:
    """True when a judge key exists, i.e. the UI should offer a key box."""
    return bool(_JUDGE)


def require_paid_access(request: Request) -> None:
    """403 unless the caller holds the team token or the judge key. Call before any paid model call."""
    if _verdict(request) in ("team", "judge"):
        return
    # One body for "no key" and "wrong key", so a response never says which it was.
    raise HTTPException(403, "live model calls need a judge key; the cached demo is open to everyone")


def limit(request: Request, bucket: str, per_hour: int) -> None:
    if _is_team(request):
        return
    q, now = _hits[(bucket, client_ip(request))], time.time()
    while q and now - q[0] > 3600:
        q.popleft()
    if len(q) >= per_hour:
        raise HTTPException(429, f"rate limit: {per_hour}/hour for {bucket}")
    q.append(now)


_day: dict[str, deque] = defaultdict(deque)


def limit_global(bucket: str, per_day: int, request: Request | None = None) -> None:
    """Per-instance daily cap across ALL visitors (protects one member's Meta credits if a post goes viral)."""
    if request is not None and _is_team(request):
        return
    q, now = _day[bucket], time.time()
    while q and now - q[0] > 86400:
        q.popleft()
    if len(q) >= per_day:
        raise HTTPException(429, f"daily demo capacity for {bucket} reached; please try again tomorrow")
    q.append(now)
