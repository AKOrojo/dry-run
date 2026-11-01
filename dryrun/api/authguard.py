"""Brute-force guard for the judge key and the team token (owner: Eng D).

Both keys are long random strings (judge ~192 bits, team ~128 bits), so guessing is already hopeless. This is defence
in depth, and it stops anyone from probing:
  - per client IP: 5 wrong keys within 15 min lock that IP for 15 min, doubling on each repeat lock up to 24 h
    (the doubling resets after a quiet day). A locked IP is refused even with the right key, so a lucky guess
    can't be confirmed.
  - globally: more than 50 wrong keys in an hour across all IPs (a distributed attempt) lock key auth for
    everyone for 30 min. Requests without a key (the cached demo) are never affected.
State is shared by every Cloud Run instance: small JSON objects in the private data bucket (private/auth/...),
updated with generation checks (storage.update_json). Only requests that present a key touch it; a right key
only reads it, a wrong key costs one write.
Parallel keys from one IP are checked one at a time inside an instance (guarded()), so a burst of guesses gets
5 comparisons, then the lock; wrong keys that reach an already locked IP add no strike. A right key is refused
only while its IP (or key auth globally) is locked.
If that store errors, the guard fails open (logged): blocking every judge because of a storage hiccup is worse
than losing a defence-in-depth layer over keys of that strength. A wrong key whose failure cannot be recorded
because other writers keep winning is refused instead (busy), so a burst cannot outrun the count.
Submitted keys are never logged.
Locked responses: 429 with Retry-After (seconds) and X-Auth-Lockout: ip | global | busy (busy: too many key
checks at once from one address, or a failure that could not be recorded; never says "wrong keys").
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
import time
from contextlib import contextmanager

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
BUSY_RETRY_S = 3
GUARD_WAIT_S = 2.0
STATE_CACHE_S = 1.0

_GLOBAL = "auth/global.json"


def _ip_rel(ip: str) -> str:
    return f"auth/ip/{hashlib.sha256(ip.encode()).hexdigest()[:24]}.json"


def _locked(retry_after: float, scope: str) -> HTTPException:
    mins = max(1, round(retry_after / 60))
    return HTTPException(429, f"too many wrong keys; try again in {mins} min",
                         headers={"Retry-After": str(int(retry_after) + 1), "X-Auth-Lockout": scope})


def _busy() -> HTTPException:
    return HTTPException(429, "too many key checks at once from this address; try again in a few seconds",
                         headers={"Retry-After": str(BUSY_RETRY_S), "X-Auth-Lockout": "busy"})


def _on_event_loop() -> bool:
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


_IP_LOCKS: dict[str, threading.Lock] = {}
_IP_LOCKS_GUARD = threading.Lock()


@contextmanager
def guarded(ip: str):
    """Serialise check -> compare -> record_failure for one IP within this instance, so parallel guesses are
    counted one by one instead of all being compared before the first failure lands.
    The wait is bounded (GUARD_WAIT_S), so one IP cannot park worker threads behind its own queue; past it the
    request gets 429 busy, even with a right key. On an event-loop thread it never waits (that would stall every
    request on the instance): async endpoints must call the auth checks through run_in_threadpool."""
    with _IP_LOCKS_GUARD:
        lk = _IP_LOCKS.setdefault(ip, threading.Lock())
    if not lk.acquire(timeout=0 if _on_event_loop() else GUARD_WAIT_S):
        log.warning("auth guard queue full for ip=%s; refusing this key attempt", ip)
        raise _busy()
    try:
        yield
    finally:
        lk.release()
    with _IP_LOCKS_GUARD:
        if not lk.locked() and len(_IP_LOCKS) > 4096:  # keep the map small; a racing request just makes a new lock
            _IP_LOCKS.pop(ip, None)


_STATE: dict[str, tuple[float, dict]] = {}  # rel -> (monotonic read time, doc): what this instance last saw


def _read(rel: str) -> dict:
    """The guard doc, re-read at most every STATE_CACHE_S: queued right keys from one IP don't each pay the store
    round trips. This instance's own writes update it at once, other instances' within STATE_CACHE_S."""
    hit = _STATE.get(rel)
    if hit is not None and time.monotonic() - hit[0] < STATE_CACHE_S:
        return hit[1]
    doc = storage.read_json("private", rel) or {}
    _STATE[rel] = (time.monotonic(), doc)
    if len(_STATE) > 4096:
        _STATE.clear()
    return doc


def _saw(rel: str, doc: dict) -> None:
    _STATE[rel] = (time.monotonic(), doc)


def check(ip: str, now: float | None = None) -> None:
    """Raise 429 if key auth is locked for this IP or globally. Call before comparing any presented key."""
    now = time.time() if now is None else now
    try:
        g = _read(_GLOBAL)
        if g.get("locked_until", 0) > now:
            raise _locked(g["locked_until"] - now, "global")
        s = _read(_ip_rel(ip))
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - fail open, see the module docstring
        log.exception("auth guard store unreadable; allowing the key check for %s", ip)
        return
    if s.get("locked_until", 0) > now:
        raise _locked(s["locked_until"] - now, "ip")


def record_failure(ip: str, now: float | None = None) -> None:
    """One wrong key from ip: update its window and the global window; lock when a threshold is crossed.
    Raises 429 (ip) if another instance locked ip meanwhile, and 429 (busy) if the failure could not be recorded."""
    now = time.time() if now is None else now
    out: dict = {}

    def per_ip(cur):
        s = dict(cur or {})
        out.clear()
        if s.get("locked_until", 0) > now:  # already locked: one burst locks once
            out["locked"] = s["locked_until"] - now
            return s
        fails = [t for t in s.get("fails", []) if now - t < WINDOW_S] + [now]
        strikes = s.get("strikes", 0) if now - s.get("last_lock", 0) < STRIKE_RESET_S else 0
        if len(fails) >= MAX_FAILS:
            strikes += 1
            out["lock"] = min(MAX_LOCK_S, BASE_LOCK_S * 2 ** (strikes - 1))
            s.update(locked_until=now + out["lock"], last_lock=now)
            fails = []
        s.update(fails=fails, strikes=strikes)
        return s

    def glob(cur):
        g = dict(cur or {})
        fails = [t for t in g.get("fails", []) if now - t < GLOBAL_WINDOW_S] + [now]
        out.pop("global_lock", None)
        if len(fails) > GLOBAL_MAX_FAILS and g.get("locked_until", 0) <= now:
            g["locked_until"] = now + GLOBAL_LOCK_S
            out["global_lock"] = len(fails)
        g["fails"] = fails[-(GLOBAL_MAX_FAILS + 1):]
        return g

    try:
        s = storage.update_json("private", _ip_rel(ip), per_ip)
        _saw(_ip_rel(ip), s)
    except storage.Contended:
        log.warning("auth guard contended for ip=%s; refusing the key attempt", ip)
        raise _busy() from None
    except Exception:  # noqa: BLE001 - fail open, see the module docstring
        log.exception("auth guard store unwritable; failure from %s not recorded", ip)
        return
    if "locked" in out:
        raise _locked(out["locked"], "ip")
    if "lock" in out:
        log.warning("auth lockout: ip=%s locked %ds (strike %d)", ip, out["lock"], s.get("strikes", 0))
    try:
        g = storage.update_json("private", _GLOBAL, glob, attempts=16)
        _saw(_GLOBAL, g)
    except Exception:  # noqa: BLE001 - the per-IP lock above still bounds each address
        log.exception("auth guard: global failure count from %s not recorded", ip)
        return
    if "global_lock" in out:
        log.error("auth lockout: GLOBAL, %d wrong keys in the last hour; key auth off for %ds",
                  out["global_lock"], GLOBAL_LOCK_S)
    log.info("auth failure: ip=%s ip_fails=%d strikes=%d global_fails=%d", ip, len(s.get("fails", [])),
             s.get("strikes", 0), len(g.get("fails", [])))


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
