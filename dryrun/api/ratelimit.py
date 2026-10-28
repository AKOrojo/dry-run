"""Tiny per-IP, per-instance rate limiter (owner: Eng D). Protects the public demo URL
from runaway cost (Meta credits are per person; GCP is capped only by max-instances).
Team members bypass it with header X-Team-Token: $DRYRUN_ADMIN_TOKEN (rehearsals, recording)."""

from __future__ import annotations

import os
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

_hits: dict[tuple[str, str], deque] = defaultdict(deque)
_TEAM = os.getenv("DRYRUN_ADMIN_TOKEN", "").strip()
if _TEAM == "unset":  # bootstrap placeholder: no bypass
    _TEAM = ""


def client_ip(request: Request) -> str:
    # Cloud Run APPENDS the real client IP to X-Forwarded-For; earlier entries are client-controlled.
    xff = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    return xff[-1] if xff else (request.client.host if request.client else "?")


def limit(request: Request, bucket: str, per_hour: int) -> None:
    if _TEAM and request.headers.get("x-team-token") == _TEAM:
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
    if request is not None and _TEAM and request.headers.get("x-team-token") == _TEAM:
        return
    q, now = _day[bucket], time.time()
    while q and now - q[0] > 86400:
        q.popleft()
    if len(q) >= per_day:
        raise HTTPException(429, f"daily demo capacity for {bucket} reached; please try again tomorrow")
    q.append(now)
