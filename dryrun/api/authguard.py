"""Brute-force guard for the judge key and the team token (owner: Eng D).

Both keys are long random strings (judge ~192 bits, team ~128 bits), so guessing is already hopeless. This is defence
in depth, and it stops anyone from probing:
  - per client IP: 5 wrong keys within 15 min lock that IP for 15 min, doubling on each repeat lock up to 24 h
    (the doubling resets after a quiet day). A locked IP is refused even with the right key, so a lucky guess
    can't be confirmed.
  - globally: more than 50 wrong keys in an hour across all IPs (a distributed attempt) lock key auth for
    everyone for 30 min. Requests without a key (the cached demo) are never affected.
State is shared by every Cloud Run instance: small JSON objects in the private data bucket (private/auth/...),
updated with generation checks (storage.update_json). Only requests that present a key touch it.
If that store errors, the guard fails open (logged): blocking every judge because of a storage hiccup is worse
than losing a defence-in-depth layer over keys of that strength. Submitted keys are never logged.
Locked responses: 429 with Retry-After (seconds) and X-Auth-Lockout: ip | global.
"""
from __future__ import annotations

import hashlib
import logging
import time

from fastapi import HTTPException

from dryrun import storage

log = logging.getLogger("dryrun.authguard")

WINDOW_S = 15 * 60
MAX_FAILS = 5
BASE_LOCK_S = 15 * 60
MAX_LOCK_S = 24 * 3600
STRIKE_RESET_S = 24 * 3600
GLOBAL_WINDOW_S = 3600
GLOBAL_MAX_FAILS = 50
GLOBAL_LOCK_S = 30 * 60

_GLOBAL = "auth/global.json"


def _ip_rel(ip: str) -> str:
    return f"auth/ip/{hashlib.sha256(ip.encode()).hexdigest()[:24]}.json"


def _locked(retry_after: float, scope: str) -> HTTPException:
    mins = max(1, round(retry_after / 60))
    return HTTPException(429, f"too many wrong keys; try again in {mins} min",
                         headers={"Retry-After": str(int(retry_after) + 1), "X-Auth-Lockout": scope})


def check(ip: str, now: float | None = None) -> None:
    """Raise 429 if key auth is locked for this IP or globally. Call before comparing any presented key."""
    now = time.time() if now is None else now
    try:
        g = storage.read_json("private", _GLOBAL) or {}
        if g.get("locked_until", 0) > now:
            raise _locked(g["locked_until"] - now, "global")
        s = storage.read_json("private", _ip_rel(ip)) or {}
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - fail open, see the module docstring
        log.exception("auth guard store unreadable; allowing the key check for %s", ip)
        return
    if s.get("locked_until", 0) > now:
        raise _locked(s["locked_until"] - now, "ip")


def record_failure(ip: str, now: float | None = None) -> None:
    """One wrong key from ip: update its window and the global window; lock when a threshold is crossed."""
    now = time.time() if now is None else now

    def per_ip(cur):
        s = dict(cur or {})
        fails = [t for t in s.get("fails", []) if now - t < WINDOW_S] + [now]
        strikes = s.get("strikes", 0) if now - s.get("last_lock", 0) < STRIKE_RESET_S else 0
        if len(fails) >= MAX_FAILS:
            strikes += 1
            lock = min(MAX_LOCK_S, BASE_LOCK_S * 2 ** (strikes - 1))
            s.update(locked_until=now + lock, last_lock=now)
            fails = []
            log.warning("auth lockout: ip=%s locked %ds (strike %d)", ip, lock, strikes)
        s.update(fails=fails, strikes=strikes)
        return s

    def glob(cur):
        g = dict(cur or {})
        fails = [t for t in g.get("fails", []) if now - t < GLOBAL_WINDOW_S] + [now]
        if len(fails) > GLOBAL_MAX_FAILS and g.get("locked_until", 0) <= now:
            g["locked_until"] = now + GLOBAL_LOCK_S
            log.error("auth lockout: GLOBAL, %d wrong keys in the last hour; key auth off for %ds",
                      len(fails), GLOBAL_LOCK_S)
        g["fails"] = fails[-(GLOBAL_MAX_FAILS + 1):]
        return g

    try:
        s = storage.update_json("private", _ip_rel(ip), per_ip)
        g = storage.update_json("private", _GLOBAL, glob)
        log.info("auth failure: ip=%s ip_fails=%d strikes=%d global_fails=%d", ip, len(s.get("fails", [])),
                 s.get("strikes", 0), len(g.get("fails", [])))
    except Exception:  # noqa: BLE001 - fail open, see the module docstring
        log.exception("auth guard store unwritable; failure from %s not recorded", ip)


def status(now: float | None = None) -> dict:
    """Admin view: the global window and every IP currently locked (hashed ids, never raw keys)."""
    now = time.time() if now is None else now
    g = storage.read_json("private", _GLOBAL) or {}
    locked = []
    for rel in storage.list_rel("private", "auth/ip/"):
        s = storage.read_json("private", rel) or {}
        if s.get("locked_until", 0) > now:
            locked.append({"ip_hash": rel.rsplit("/", 1)[-1].removesuffix(".json"),
                           "retry_after_s": round(s["locked_until"] - now), "strikes": s.get("strikes", 0)})
    return {"global_locked": g.get("locked_until", 0) > now,
            "global_retry_after_s": max(0, round(g.get("locked_until", 0) - now)),
            "global_fails_last_hour": len([t for t in g.get("fails", []) if now - t < GLOBAL_WINDOW_S]),
            "locked_ips": locked,
            "thresholds": {"per_ip": f"{MAX_FAILS} in {WINDOW_S // 60} min",
                           "global": f">{GLOBAL_MAX_FAILS} per hour"}}
