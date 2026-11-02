"""Agent + Meta-model endpoints (owner: Eng C). Mounted by api/main.py."""

from __future__ import annotations

import os
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, StringConstraints
from starlette.concurrency import run_in_threadpool

from dryrun.api.ratelimit import limit, limit_global, require_paid_access

router = APIRouter(prefix="/api")


class AgentRequest(BaseModel):
    # Stripped first, so a blank or whitespace-only question is a 422 before any provider (paid or not) runs.
    question: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
    provider: str = os.getenv("DRYRUN_AGENT_PROVIDER", "replay")  # meta | baseten | openrouter | fake | replay
    aoi_id: str | None = None  # default: DRYRUN_DEFAULT_AOI


@router.post("/agent")
def agent(req: AgentRequest, request: Request):
    from dryrun.agent import replay
    from dryrun.agent.loop import run
    from dryrun.api.main import _check_aoi

    if req.aoi_id is not None:
        _check_aoi(req.aoi_id)  # 400 malformed, 404 unknown, before any paid call
    if req.provider not in {"meta", "baseten", "openrouter", "fake", "replay"}:
        raise HTTPException(400, "provider must be meta | baseten | openrouter | fake | replay")
    paid = req.provider not in {"fake", "replay"}  # meta, baseten and openrouter bill the team's credits
    rec = None
    if req.provider == "replay":
        rec = replay.find(req.question)
        if rec is None:
            raise HTTPException(404, "no recorded session for this question (GET /api/replays lists them)")
    if paid:
        require_paid_access(request)
    limit(request, "agent", per_hour=int(os.getenv("DRYRUN_AGENT_PER_HOUR", "12")))
    if paid:
        limit_global("agent", per_day=int(os.getenv("DRYRUN_AGENT_PER_DAY", "300")), request=request)

    def sse():
        events = replay.stream(rec) if rec else run(req.question, req.provider, req.aoi_id)
        for ev in events:
            yield f"data: {ev.model_dump_json()}\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/replays")
def replays():
    """Recorded live sessions available as the labelled replay fallback."""
    from dryrun.agent import replay

    return [{k: r[k] for k in ("question", "aoi_id", "provider", "model", "recorded_at")} for r in replay.recordings()]


@router.get("/aois")
def aois():
    """AOIs the UI can switch between: the default plus every AOI with presets, if its data exists."""
    from dryrun import presets, storage

    ids = [os.getenv("DRYRUN_DEFAULT_AOI", "fixture-synthetic")]
    ids += sorted({s["aoi_id"] for s in presets.demo()["scenarios"]} - set(ids))
    out = []
    for aoi_id in ids:
        try:
            out.append({"aoi_id": aoi_id, "name": storage.load_aoi(aoi_id).name})
        except Exception:  # noqa: BLE001 - not published in this storage (e.g. local dev)
            continue
    return out


@router.get("/runs/{run_id}/area")
def get_area(run_id: str, place: str):
    """Stats inside a named place (same numbers the agent cites as area:<place>:<stat>)."""
    from dryrun.api.main import _check_run
    from dryrun.sim.engine import area_stats

    _check_run(run_id)
    return area_stats(run_id, place)


MAX_UPLOAD_BYTES = 8 * 1024 * 1024


@router.post("/observe")
async def observe(request: Request, file: UploadFile = File(...), lon: float = Form(...),
                  lat: float = Form(...), run_id: str | None = Form(None),
                  t_s: int | None = Form(None), source: str = Form("citizen_photo")):
    # Off the event loop: the key check can wait on the shared lockout store (authguard).
    await run_in_threadpool(require_paid_access, request)
    await run_in_threadpool(limit, request, "observe", per_hour=20)  # SAM 3.1 + Spark vision cost money
    import re

    from dryrun.meta import observe

    if source not in {"citizen_photo", "drone_video", "satellite_chip"}:
        raise HTTPException(400, "invalid source")
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise HTTPException(400, "invalid coordinates")
    if run_id is not None and not re.fullmatch(r"r_[0-9a-f]{16}", run_id):
        raise HTTPException(400, "invalid run_id")
    if file.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(415, "unsupported image type")
    image = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(image) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "image too large")
    import httpx

    try:
        result = await run_in_threadpool(observe.observe, image, lon, lat, t_s, source, run_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except httpx.HTTPError as exc:  # Meta API down or rejecting: not the caller's fault
        raise HTTPException(502, "model call failed; try again later") from exc
    return result.model_dump()


@router.get("/observations/{obs_id}/mask.png")
def observation_mask(obs_id: str):
    import re

    from fastapi.responses import Response

    from dryrun import storage

    if not re.fullmatch(r"ob_[0-9a-f]{12}", obs_id):
        raise HTTPException(404, "observation not found")
    try:
        png = storage.read_upload(f"observations/{obs_id}/mask.png")
    except Exception as exc:  # noqa: BLE001 - missing object in local or GCS mode
        raise HTTPException(404, "observation not found") from exc
    return Response(png, media_type="image/png")


@router.websocket("/voice")
async def voice(ws: WebSocket):
    from dryrun.meta import media

    await ws.accept()
    await media.relay_voice(ws)
