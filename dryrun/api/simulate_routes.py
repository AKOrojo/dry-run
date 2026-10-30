"""Simulate with an estimate, live progress and cancel (owner: Eng D). The UI contract:

POST /api/simulate/estimate  ScenarioSpec ->
    {run_id, cached, status: done|running|failed|none, est_s, est_basis: cached|speed_model|history|null, t_end_s,
     output_interval_s, frames_total}
POST /api/simulate/stream    ScenarioSpec -> text/event-stream of {"kind", "data"}:
    started   {job_id, run_id, cached, est_s, est_basis, t_end_s, output_interval_s, frames_total}  always first
    progress  {phase: queued|solving|saving, sim_t_s, t_end_s, fraction, elapsed_s, eta_s, measured}  ~1/s
    done      {manifest}                                              terminal
    cancelled {reason}                                                terminal
    error     {code, message, retryable}                              terminal
Cancel = close the stream (AbortController). Viewers of one run_id share one job, and the work stops when the last
one leaves. A stream, not start-and-poll: Cloud Run gives CPU only while a request is open, and the stream's own
connection always reaches the instance doing the work (a DELETE could land on another instance).
POST /api/simulate (synchronous) is unchanged for the agent and older clients.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import statistics
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from dryrun import jobs, storage
from dryrun.api.ratelimit import limit
from dryrun.contracts import RunStatus, ScenarioSpec

router = APIRouter(prefix="/api/simulate")
log = logging.getLogger(__name__)
_WORK = ThreadPoolExecutor(4)  # the engine serialises solves itself (_SOLVE); this only holds waiting jobs
TICK_S = 1.0


def _backend() -> str:
    return os.getenv("DRYRUN_SIM_BACKEND", "fake")


@lru_cache(maxsize=16)
def _history_s_per_sim_hour(aoi_id: str, backend: str) -> float | None:
    """Median elapsed_s per simulated hour over this AOI's finished demo runs (the fallback estimate)."""
    from dryrun import presets

    rates = []
    for s in presets.demo()["scenarios"]:
        if s["aoi_id"] != aoi_id:
            continue
        try:
            spec = ScenarioSpec.model_validate(s)
            m = storage.load_run(spec.run_id())
        except Exception:  # noqa: BLE001 - preset not warmed in this storage
            continue
        if m.status == RunStatus.done and m.elapsed_s and m.backend == backend and spec.sim_hours > 0:
            rates.append(m.elapsed_s / spec.sim_hours)
    return statistics.median(rates) if rates else None


def _status(run_id: str) -> str:
    if not storage.run_exists(run_id):
        return "none"
    m = storage.load_run(run_id)
    if m.status == RunStatus.failed and "Cancelled" in (m.error or ""):
        return "none"  # a cancelled run is simply not there yet
    return m.status.value


def estimate_for(spec: ScenarioSpec) -> dict:
    from dryrun.sim import interventions

    run_id = spec.run_id()
    status = _status(run_id)
    t_end = interventions.t_end_s(spec)
    interval = spec.output_interval_min * 60
    out = {"run_id": run_id, "cached": status == "done", "status": status, "est_s": None, "est_basis": None,
           "t_end_s": t_end, "output_interval_s": interval, "frames_total": t_end // interval + 1}
    if status == "done":
        return {**out, "est_s": 0.0, "est_basis": "cached"}
    try:
        from dryrun import speed  # Eng A's speed model, when it lands

        fn = getattr(speed, "estimate_s", None)
    except ImportError:
        fn = None
    if fn is not None:
        try:
            return {**out, "est_s": round(float(fn(storage.load_aoi(spec.aoi_id), spec, _backend())), 1),
                    "est_basis": "speed_model"}
        except Exception:  # noqa: BLE001 - never let an estimate break Simulate
            log.exception("speed.estimate_s failed; using history")
    rate = _history_s_per_sim_hour(spec.aoi_id, _backend())
    if rate is not None:
        return {**out, "est_s": round(rate * spec.sim_hours, 1), "est_basis": "history"}
    return out


def _writes_total(frames_total: int) -> int:
    return 2 * frames_total + 3  # a png and an npy per frame, then max depth (png, npy) and building depths


def _validate(spec: ScenarioSpec) -> None:
    from dryrun.api.main import _check_aoi
    from dryrun.sim.engine import validate

    _check_aoi(spec.aoi_id)
    validate(spec)  # ValueError -> 400 through the app's handler, before any stream starts


@router.post("/estimate")
def estimate(spec: ScenarioSpec, request: Request):
    limit(request, "simulate_estimate", per_hour=600)
    _validate(spec)
    return estimate_for(spec)


def _work(job: jobs.Job, spec: ScenarioSpec) -> None:
    from dryrun.sim.engine import run_scenario

    token = jobs.bind(job)
    try:
        m = run_scenario(spec)
        if job.cancelled:
            jobs.finish(job, error=jobs.Cancelled(job.run_id))
        elif m.status == RunStatus.done:
            jobs.finish(job, manifest=m)
        else:
            jobs.finish(job, error=RuntimeError(m.error or f"run {m.status.value}"))
    except BaseException as exc:  # noqa: BLE001 - every outcome must release the watchers
        jobs.finish(job, error=exc)
    finally:
        jobs.unbind(token)


def _event(kind: str, data: dict) -> str:
    return f"data: {json.dumps({'kind': kind, 'data': data})}\n\n"


@router.post("/stream")
async def stream(spec: ScenarioSpec, request: Request):
    limit(request, "simulate", per_hour=60)  # the same budget as POST /api/simulate
    await asyncio.to_thread(_validate, spec)
    est = await asyncio.to_thread(estimate_for, spec)
    job_id = uuid.uuid4().hex[:12]

    async def sse():
        keys = ("run_id", "cached", "est_s", "est_basis", "t_end_s", "output_interval_s", "frames_total")
        started = {"job_id": job_id, **{k: est[k] for k in keys}}
        yield _event("started", started)
        if est["cached"]:
            m = await asyncio.to_thread(storage.load_run, est["run_id"])
            yield _event("done", {"manifest": json.loads(m.model_dump_json())})
            return
        job, created = jobs.attach(est["run_id"], est["t_end_s"], est["est_s"], _writes_total(est["frames_total"]))
        try:
            if created:
                _WORK.submit(_work, job, spec)
            while not job.finished.is_set():
                yield _event("progress", job.progress())
                if await request.is_disconnected():
                    return
                await asyncio.to_thread(job.finished.wait, TICK_S)
            if job.manifest is not None:
                yield _event("progress", {**job.progress(), "phase": "saving", "fraction": 1.0, "eta_s": 0.0})
                yield _event("done", {"manifest": json.loads(job.manifest.model_dump_json())})
            elif isinstance(job.error, jobs.Cancelled):
                yield _event("cancelled", {"reason": "every viewer of this run left"})
            else:
                log.error("simulate stream %s failed: %r", est["run_id"], job.error)
                yield _event("error", {"code": "simulate_failed", "retryable": True,
                                       "message": "The simulation failed. Try again, or change the storm."})
        finally:  # runs on normal end, on disconnect (CancelledError) and on errors
            jobs.detach(job)

    return StreamingResponse(sse(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
