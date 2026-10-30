"""Live simulate jobs: progress, ETA and cancel for POST /api/simulate/stream (owner: Eng D).

Outside dryrun/sim on purpose: SOLVER_VERSION hashes the sim sources, so nothing here changes a run_id.

One job per run_id per instance. Every stream watching that run is a watcher; when the last one leaves before the
run finishes, the job is marked cancelled and the next hook raises Cancelled, which stops the work:
  - tick(t, t_end): called by the solver at each output frame (Eng A's hook). A cheap no-op when no job is
    bound to the thread (CLI, tests, warm_cache), so the solver can always call it.
  - on_save_run / on_write: called by dryrun.storage, so the queued -> solving -> saving phases and the save
    progress are visible (and a cancel stops the uploads) even before the solver hook exists.
Progress is "measured" only from the solver hook; until then the solving fraction is elapsed / est_s.
"""
from __future__ import annotations

import contextvars
import threading
import time
from dataclasses import dataclass, field

SOLVE_SHARE = 0.9  # share of the bar for solving; the rest is saving frames
UNMEASURED_CAP = 0.95  # an estimate-driven bar never claims to be finished


class Cancelled(Exception):
    """Every client watching this run left: stop computing. Not a failure, so callers should not persist it."""


@dataclass
class Job:
    run_id: str
    t_end_s: int
    est_s: float | None
    writes_total: int
    started: float = field(default_factory=time.monotonic)
    phase: str = "queued"  # queued -> solving -> saving
    sim_t_s: float = 0.0
    measured: bool = False
    writes: int = 0
    watchers: int = 0
    cancelled: bool = False
    finished: threading.Event = field(default_factory=threading.Event)
    manifest: object = None
    error: BaseException | None = None

    def progress(self) -> dict:
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
        else:
            eta = max(0.0, self.est_s - elapsed) if self.est_s else None
        sim_t = self.sim_t_s if self.measured else (frac / SOLVE_SHARE * self.t_end_s if self.phase == "solving" else
                                                    (self.t_end_s if self.phase == "saving" else 0.0))
        return {"phase": self.phase, "sim_t_s": round(min(sim_t, self.t_end_s), 1), "t_end_s": self.t_end_s,
                "fraction": round(frac, 3), "elapsed_s": round(elapsed, 1),
                "eta_s": None if eta is None else round(max(0.0, eta), 1),
                "measured": self.measured or self.phase == "saving"}


_JOBS: dict[str, Job] = {}
_LOCK = threading.Lock()
_current: contextvars.ContextVar[Job | None] = contextvars.ContextVar("dryrun_job", default=None)


def attach(run_id: str, t_end_s: int, est_s: float | None, writes_total: int) -> tuple[Job, bool]:
    """Watch run_id's job, creating it if needed. Returns (job, created): the creator starts the work."""
    with _LOCK:
        job = _JOBS.get(run_id)
        created = job is None or job.finished.is_set()
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


def on_save_run(run_id: str, status: str) -> None:
    """storage.save_run hook: the engine writes the "running" manifest when it actually starts solving."""
    job = _JOBS.get(run_id)
    if job is None or status != "running":
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
