"""Simulate with an estimate, live progress and cancel (owner: Eng D). The UI contract:

POST /api/simulate/estimate  ScenarioSpec ->
    {run_id, cached, status: done|running|failed|none, est_s, est_basis: cached|speed_model|history|null, t_end_s,
     output_interval_s, frames_total, domain_cells, grid_cells, drainage}   (domain_cells == grid_cells: no speed-up;
     drainage: the resolved {system, capacity_mm_h, blockage_pct, outfall}, or null = the constant drain sink)
POST /api/simulate/stream    ScenarioSpec -> text/event-stream of {"kind", "data"}:
    started   {job_id, cancel_token, run_id, cached, est_s, est_basis, t_end_s, output_interval_s, frames_total}
    progress  {phase: queued|solving|saving|cancelling, sim_t_s, t_end_s, fraction, elapsed_s, eta_s, measured, joined}
              (joined: this stream attached to a job another viewer had already started for the same run_id)
    done      {manifest}                                              terminal
    cancelled {reason}                                                terminal
    error     {code, message, retryable}                              terminal
DELETE /api/simulate/jobs/{job_id}  X-Cancel-Token: <cancel_token>  -> 202 {cancelled: true} | 403 | 404
Cancel = DELETE, then close the stream (AbortController). Cloud Run does not pass a client disconnect through to
the container while the stream is open, so closing alone does not stop work in production; session affinity sends
the DELETE to the instance holding the job, and a 404 means the job already ended there. Viewers of one run_id share
one job, and the work stops when the last one leaves. A stream, not start-and-poll: Cloud Run gives CPU only while a
request is open.
POST /api/simulate (synchronous) is unchanged for the agent and older clients.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import statistics
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from dryrun import jobs, storage
from dryrun.api.ratelimit import limit
from dryrun.contracts import RunStatus, ScenarioSpec

router = APIRouter(prefix="/api/simulate")
log = logging.getLogger(__name__)
_WORK = ThreadPoolExecutor(4)  # the engine serialises solves itself (_SOLVE); this only holds waiting jobs
TICK_S = 1.0
# After a DELETE that leaves the job with no viewers, the stream stays open until the work has actually stopped:
# Cloud Run throttles CPU once no request is open, so closing at once would leave the run crawling (and its
# run_id locked) in the background.
CANCEL_WAIT_S = 120.0


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
    if m.status == RunStatus.running and not jobs.active(run_id):
        return "none"  # left behind by a stopped instance: the next Simulate just runs it
    return m.status.value


def _domain_cells(aoi, spec: ScenarioSpec, grid_cells: int) -> int:
    """Cells the solver will actually run: Eng A's rain-area window (speed.domain_cells), else the whole grid."""
    try:
        from dryrun import speed

        fn = getattr(speed, "domain_cells", None)
        return int(fn(aoi, spec)) if fn is not None else grid_cells
    except Exception:  # noqa: BLE001 - the window is a nicety; never break the estimate
        log.exception("speed.domain_cells failed; reporting the whole grid")
        return grid_cells


def _drainage(aoi, spec: ScenarioSpec) -> dict | None:
    """The drainage the run will model, with the AOI's drainage_default filled in (Eng A's drainage.settings).
    None = the AOI has no drain network, so the constant drain_sink_mm_h applies. Invalid combinations are a 400
    from validate() before this runs."""
    from dryrun.sim import drainage

    s = drainage.settings(spec, aoi)
    if s is None:
        return None
    return {"system": s.system, "capacity_mm_h": s.capacity_mm_h, "blockage_pct": round(s.blockage * 100, 1),
            "outfall": s.outfall}


def estimate_for(spec: ScenarioSpec) -> dict:
    from dryrun.sim import interventions

    run_id = spec.run_id()
    status = _status(run_id)
    t_end = interventions.t_end_s(spec)
    interval = spec.output_interval_min * 60
    aoi = storage.load_aoi(spec.aoi_id)
    grid_cells = aoi.grid.nx * aoi.grid.ny
    out = {"run_id": run_id, "cached": status == "done", "status": status, "est_s": None, "est_basis": None,
           "t_end_s": t_end, "output_interval_s": interval, "frames_total": t_end // interval + 1,
           "domain_cells": _domain_cells(aoi, spec, grid_cells), "grid_cells": grid_cells,
           "drainage": _drainage(aoi, spec)}
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
    from dryrun import speed
    from dryrun.sim.engine import run_scenario

    token = jobs.bind(job)
    t0 = time.monotonic()
    try:
        m = run_scenario(spec)
        if job.cancelled:
            jobs.finish(job, error=jobs.Cancelled(job.run_id))
        elif m.status == RunStatus.done:
            jobs.finish(job, manifest=m)
            speed.observe_run(spec, m, time.monotonic() - t0)  # after finish: viewers never wait on it
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
    await asyncio.to_thread(limit, request, "simulate", per_hour=60)  # off the loop: a key check can wait on authguard
    await asyncio.to_thread(_validate, spec)
    est = await asyncio.to_thread(estimate_for, spec)
    job_id, cancel_token = uuid.uuid4().hex[:12], secrets.token_urlsafe(16)

    async def sse():
        keys = ("run_id", "cached", "est_s", "est_basis", "t_end_s", "output_interval_s", "frames_total")
        started = {"job_id": job_id, "cancel_token": cancel_token, **{k: est[k] for k in keys}}
        yield _event("started", started)
        if est["cached"]:
            m = await asyncio.to_thread(storage.load_run, est["run_id"])
            yield _event("done", {"manifest": json.loads(m.model_dump_json())})
            return
        job, created = jobs.attach(est["run_id"], est["t_end_s"], est["est_s"], _writes_total(est["frames_total"]))
        joined = not created
        jobs.watch(job, job_id, cancel_token)
        try:
            if created:
                _WORK.submit(_work, job, spec)
            while not job.finished.is_set():
                if not jobs.watching(job_id):  # this viewer cancelled (DELETE)
                    waited = 0.0
                    while job.cancelled and not job.finished.is_set() and waited < CANCEL_WAIT_S:
                        yield _event("progress", {**job.progress(), "phase": "cancelling", "joined": joined})
                        await asyncio.to_thread(job.finished.wait, TICK_S)
                        waited += TICK_S
                    yield _event("cancelled", {"reason": "cancelled by this client"})
                    return
                yield _event("progress", {**job.progress(), "joined": joined})
                if await request.is_disconnected():
                    return
                await asyncio.to_thread(job.finished.wait, TICK_S)
            if job.manifest is not None:
                yield _event("progress", {**job.progress(), "phase": "saving", "fraction": 1.0, "eta_s": 0.0,
                                          "joined": joined})
                yield _event("done", {"manifest": json.loads(job.manifest.model_dump_json())})
            elif isinstance(job.error, jobs.Cancelled):
                yield _event("cancelled", {"reason": "every viewer of this run left"})
            else:
                log.error("simulate stream %s failed: %r", est["run_id"], job.error)
                yield _event("error", {"code": "simulate_failed", "retryable": True,
                                       "message": "The simulation failed. Try again, or change the storm."})
        finally:  # runs on normal end, on disconnect (CancelledError) and on errors
            jobs.leave(job_id)

    return StreamingResponse(sse(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.delete("/jobs/{job_id}", status_code=202)
def cancel_job(job_id: str, request: Request, x_cancel_token: str = Header("")):
    limit(request, "simulate_cancel", per_hour=600)
    ok = jobs.cancel(job_id, x_cancel_token)
    if ok is None:
        raise HTTPException(404, "no running job with that id on this instance (it may already have ended)")
    if ok is False:
        raise HTTPException(403, "wrong cancel token")
    return {"cancelled": True}
