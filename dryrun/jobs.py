"""Live simulate jobs: progress, ETA and cancel for POST /api/simulate/stream (owner: Eng D).

Outside dryrun/sim on purpose: SOLVER_VERSION hashes the sim sources, so nothing here changes a run_id.

One job per run_id per instance. Every stream watching that run is a watcher (job_id + cancel token); a watcher
leaves when its stream ends or on DELETE /api/simulate/jobs/{job_id}. Cloud Run does not pass a client's
disconnect through to the container while a stream is open, so production cancels need the DELETE (session
affinity sends it to the same instance); the disconnect path covers local runs. When the last watcher leaves
before the run finishes, the job is marked cancelled and the next hook raises Cancelled, which stops the work:
  - tick(t, t_end): called by the solver at each output frame (Eng A's hook). A cheap no-op when no job is
    bound to the thread (CLI, tests, warm_cache), so the solver can always call it.
  - on_save_run / on_write: called by dryrun.storage, so the queued -> solving -> saving phases and the save
    progress are visible (and a cancel stops the uploads) even before the solver hook exists.
Progress is "measured" only from the solver hook; until then the solving fraction is elapsed / est_s.
The engine solves one run at a time per instance, so a queued job also reports the wait ahead of it (queue_s, ahead):
the time left on the job being solved, plus the estimates of jobs queued before it. Solves started outside a stream
(POST /api/simulate, the agent) are seen through on_save_run and count too, timed with set_estimator's function.
"""
from __future__ import annotations

import contextvars
import hmac
import itertools
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

SOLVE_SHARE = 0.9  # share of the bar for solving; the rest is saving frames
UNMEASURED_CAP = 0.95  # an estimate-driven bar never claims to be finished
OTHER_MAX_AGE_S = 3600  # forget a non-stream solve that never wrote its final manifest
# Early in a measured solve, elapsed / fraction swings (Eng E saw 181 s fall to 103 s in 3 s): below this share of
# the solve, the time left is blended from the estimate towards the measured rate.
BLEND_FRAC = 0.15
_SEQ = itertools.count()


class Cancelled(Exception):
    """Every client watching this run left: stop computing. Not a failure, so callers should not persist it."""


@dataclass
class Job:
    run_id: str
    t_end_s: int
    est_s: float | None
    writes_total: int
    started: float = field(default_factory=time.monotonic)  # reset when solving begins: elapsed_s is solve-only
    attached: float = field(default_factory=lambda: time.monotonic())  # total_s counts from here, across the queue wait
    phase: str = "queued"  # queued -> solving -> saving
    sim_t_s: float = 0.0
    measured: bool = False
    writes: int = 0
    watchers: int = 0
    cancelled: bool = False
    finished: threading.Event = field(default_factory=threading.Event)
    manifest: object = None
    error: BaseException | None = None
    seq: int = field(default_factory=lambda: next(_SEQ))  # attach order: the queue order behind the engine

    def progress(self) -> dict:
        frac, eta, elapsed = self._own()
        queue_s, ahead = queue_ahead(self) if self.phase == "queued" else (0.0, 0)
        if self.phase == "queued":
            eta = None if eta is None or queue_s is None else eta + queue_s
        sim_t = self.sim_t_s if self.measured else (frac / SOLVE_SHARE * self.t_end_s if self.phase == "solving" else
                                                    (self.t_end_s if self.phase == "saving" else 0.0))
        return {"phase": self.phase, "sim_t_s": round(min(sim_t, self.t_end_s), 1), "t_end_s": self.t_end_s,
                "fraction": round(frac, 3), "elapsed_s": round(elapsed, 1),
                "total_s": round(time.monotonic() - self.attached, 1),
                "eta_s": None if eta is None else round(max(0.0, eta), 1),
                "queue_s": None if queue_s is None else round(queue_s, 1), "ahead": ahead,
                "measured": self.measured or self.phase == "saving"}

    def _own(self) -> tuple[float, float | None, float]:
        """(fraction, seconds left on this job's own solve and save, elapsed), ignoring any queue ahead."""
        now = time.monotonic()
        elapsed = now - self.started
        if self.phase == "saving":
            frac = SOLVE_SHARE + (1 - SOLVE_SHARE) * min(1.0, self.writes / max(1, self.writes_total))
        elif self.phase == "solving" and self.measured:
            frac = SOLVE_SHARE * min(1.0, self.sim_t_s / max(1, self.t_end_s))
        elif self.phase == "solving" and self.est_s:
            frac = min(UNMEASURED_CAP, elapsed / self.est_s) * SOLVE_SHARE
        else:
            frac = 0.0
        if self.phase == "queued":
            eta = self.est_s
        elif frac > 0.02 and (self.measured or self.phase == "saving"):
            eta = elapsed / frac - elapsed
            w = min(1.0, frac / (SOLVE_SHARE * BLEND_FRAC)) ** 2  # squared: the first few % barely move it
            if self.est_s and w < 1.0:
                eta = w * eta + (1 - w) * max(0.0, self.est_s - elapsed)
        else:
            eta = max(0.0, self.est_s - elapsed) if self.est_s else None
        return frac, eta, elapsed


@dataclass
class _Other:
    """A solve this instance is running for a caller without a stream (POST /api/simulate, the agent)."""
    started: float
    scenario: object
    est_s: float | None = None
    estimated: bool = False


_JOBS: dict[str, Job] = {}
_OTHER: dict[str, _Other] = {}
_ESTIMATOR: Callable[[object], float | None] | None = None
_WATCHERS: dict[str, tuple[Job, str]] = {}  # job_id (one per stream) -> (job, cancel token)
_LOCK = threading.Lock()
_current: contextvars.ContextVar[Job | None] = contextvars.ContextVar("dryrun_job", default=None)


def set_estimator(fn: Callable[[object], float | None]) -> None:
    """How long a ScenarioSpec takes to solve here (the simulate route's speed model), for non-stream solves."""
    global _ESTIMATOR
    _ESTIMATOR = fn


def queue_ahead(job: Job | None = None) -> tuple[float | None, int]:
    """(seconds until the engine is free for job, runs ahead of it) on this instance. job=None: a job attached now.
    Seconds are None when a run ahead has no estimate."""
    with _LOCK:
        mine = None if job is None else job.seq
        jobs_ahead = [j for j in _JOBS.values() if j is not job and not j.finished.is_set() and not j.cancelled
                      and (j.phase != "queued" or mine is None or j.seq < mine)]
        now = time.monotonic()
        for rid, o in list(_OTHER.items()):
            if now - o.started > OTHER_MAX_AGE_S:
                del _OTHER[rid]
        others = [o for rid, o in _OTHER.items() if rid not in _JOBS]
    total, unknown = 0.0, False
    for j in jobs_ahead:
        left = j.est_s if j.phase == "queued" else j._own()[1]
        if left is None:
            unknown = True
        else:
            total += max(0.0, left)
    for o in others:
        if not o.estimated:  # outside _LOCK: the estimator reads storage
            o.estimated = True
            try:
                o.est_s = _ESTIMATOR(o.scenario) if _ESTIMATOR is not None else None
            except Exception:  # noqa: BLE001 - a queue hint must never break a progress event
                o.est_s = None
        if o.est_s is None:
            unknown = True
        else:
            total += max(0.0, o.est_s - (time.monotonic() - o.started))
    return (None if unknown else total), len(jobs_ahead) + len(others)


def attach(run_id: str, t_end_s: int, est_s: float | None, writes_total: int) -> tuple[Job, bool]:
    """Watch run_id's job, creating it if needed. Returns (job, created): the creator starts the work.

    A job that is being cancelled is never joined: a Simulate pressed right after Stop gets a fresh job, whose work
    waits on the engine's per-run lock until the old thread has unwound (Eng C found the race)."""
    with _LOCK:
        job = _JOBS.get(run_id)
        created = job is None or job.finished.is_set() or job.cancelled
        if created:
            job = _JOBS[run_id] = Job(run_id, t_end_s, est_s, writes_total)
        job.watchers += 1
        return job, created


def detach(job: Job) -> None:
    """A watcher left. The last one leaving an unfinished job cancels it."""
    with _LOCK:
        job.watchers -= 1
        if job.watchers <= 0 and not job.finished.is_set():
            job.cancelled = True


def active(run_id: str) -> bool:
    """A job for run_id is live on this instance."""
    job = _JOBS.get(run_id)
    return job is not None and not job.finished.is_set()


def watch(job: Job, watcher_id: str, token: str) -> None:
    """Register a stream that attach() already counted, so it can be cancelled by id."""
    with _LOCK:
        _WATCHERS[watcher_id] = (job, token)


def watching(watcher_id: str) -> bool:
    return watcher_id in _WATCHERS


def leave(watcher_id: str) -> None:
    """A stream ended or was cancelled. Idempotent: the DELETE and the stream's own cleanup may both call it."""
    with _LOCK:
        entry = _WATCHERS.pop(watcher_id, None)
    if entry is not None:
        detach(entry[0])


def cancel(watcher_id: str, token: str) -> bool | None:
    """DELETE /api/simulate/jobs/{id}: None = not on this instance (or already over), False = wrong token."""
    entry = _WATCHERS.get(watcher_id)
    if entry is None:
        return None
    if not hmac.compare_digest(entry[1], token or ""):
        return False
    leave(watcher_id)
    return True


def finish(job: Job, manifest=None, error: BaseException | None = None) -> None:
    job.manifest, job.error = manifest, error
    job.finished.set()
    with _LOCK:
        if _JOBS.get(job.run_id) is job:
            del _JOBS[job.run_id]


def bind(job: Job) -> contextvars.Token:
    return _current.set(job)


def unbind(token: contextvars.Token) -> None:
    _current.reset(token)


def tick(t_s: float, t_end_s: float) -> None:
    """Solver hook: one call per output frame (and every few hundred steps). No job bound: no-op."""
    job = _current.get()
    if job is None:
        return
    job.phase, job.sim_t_s, job.measured = "solving", float(t_s), True
    if job.cancelled:
        raise Cancelled(job.run_id)


def on_save_run(run_id: str, status: str, scenario: object = None) -> None:
    """storage.save_run hook: the engine writes the "running" manifest when it actually starts solving."""
    bound = _current.get()  # the engine thread carries its own job; prefer it over the newest job for this run_id
    job = bound if bound is not None and bound.run_id == run_id else _JOBS.get(run_id)
    if job is None:  # a solve without a stream: it still holds the engine, so queued jobs wait for it
        with _LOCK:
            if status == "running" and scenario is not None:
                _OTHER[run_id] = _Other(time.monotonic(), scenario)
            else:
                _OTHER.pop(run_id, None)
        return
    if status != "running":
        return
    if job.cancelled:  # left while queued behind another solve: never start this one
        raise Cancelled(run_id)
    if job.phase == "queued":
        job.phase, job.started = "solving", time.monotonic()


def on_write(run_id: str) -> None:
    """storage.write_run_file hook (runs in the engine's upload threads, so keyed by run_id, not the contextvar)."""
    job = _JOBS.get(run_id)
    if job is None:
        return
    if job.phase != "saving":
        job.phase = "saving"
        job.sim_t_s = float(job.t_end_s)
    job.writes += 1
    if job.cancelled:
        raise Cancelled(run_id)
