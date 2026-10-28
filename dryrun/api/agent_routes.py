"""Agent + Meta-model endpoints (owner: Eng C). Mounted by api/main.py."""

from __future__ import annotations

import json
import os

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from dryrun.api.ratelimit import limit, limit_global

router = APIRouter(prefix="/api")


class AgentRequest(BaseModel):
    question: str = Field(max_length=1000)
    provider: str = os.getenv("DRYRUN_AGENT_PROVIDER", "fake")  # meta | baseten | fake


@router.post("/agent")
def agent(req: AgentRequest, request: Request):
    from dryrun.agent.loop import run

    limit(request, "agent", per_hour=int(os.getenv("DRYRUN_AGENT_PER_HOUR", "12")))
    limit_global("agent", per_day=int(os.getenv("DRYRUN_AGENT_PER_DAY", "300")), request=request)
    if req.provider not in {"meta", "baseten", "fake"}:
        raise HTTPException(400, "provider must be meta | baseten | fake")

    def sse():
        for ev in run(req.question, req.provider):
            yield f"data: {ev.model_dump_json()}\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/runs/{run_id}/area")
def get_area(run_id: str, place: str):
    """Stats inside a named place (same numbers the agent cites as area:<place>:<stat>)."""
    from dryrun.api.main import _check_run
    from dryrun.sim.engine import area_stats

    _check_run(run_id)
    return area_stats(run_id, place)


@router.post("/observe")
async def observe(request: Request, file: UploadFile = File(...), lon: float = Form(...),
                  lat: float = Form(...), run_id: str | None = Form(None)):
    limit(request, "observe", per_hour=20)  # SAM 3.1 + Spark vision cost money
    raise HTTPException(501, "Eng C: SAM 3.1 observe pipeline lands Day 3-5")


@router.websocket("/voice")
async def voice(ws: WebSocket):
    await ws.accept()
    await ws.send_text(json.dumps({"type": "error", "error": "Eng C: voice relay lands Day 5"}))
    await ws.close()
