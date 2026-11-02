"""Muse Image before/after endpoint (dryrun/meta/render.py; Eng C reviews the Meta call).

POST /api/render                      multipart form: RenderRequest fields, optional `file` (your own street photo)
GET  /api/render/{render_id}          the stored RenderResult
GET  /api/render/{render_id}/{name}.webp   before | after | photo (private storage, served here)

A cached render is free and needs no key. A new one makes three Muse Image calls, so it needs the judge or team key
and counts against the per-IP and daily caps, like the agent routes.
"""

import os
import re

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from dryrun.api.ratelimit import limit, limit_global, require_paid_access

router = APIRouter(prefix="/api")

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
_ID = re.compile(r"v_[0-9a-f]{16}")


@router.post("/render")
async def render(request: Request, base_run_id: str = Form(...), alt_run_id: str = Form(...),
                 lon: float = Form(...), lat: float = Form(...), view: str = Form("street"),
                 provider: str = Form("meta"), file: UploadFile | None = File(None)):
    import httpx
    from pydantic import ValidationError
    from starlette.concurrency import run_in_threadpool

    from dryrun.contracts import RenderRequest
    from dryrun.meta import media
    from dryrun.meta import render as R

    try:
        req = RenderRequest(base_run_id=base_run_id, alt_run_id=alt_run_id, center=(lon, lat), view=view,
                            provider=provider)
    except ValidationError as exc:
        raise HTTPException(422, "invalid render request: " + "; ".join(e["msg"] for e in exc.errors())) from None
    # Fake pictures land in the shared render cache, so only a dev or test server may make them.
    if req.provider == "fake" and os.getenv("DRYRUN_ALLOW_FAKE_RENDER") != "1":
        raise HTTPException(400, "provider=fake is only for local testing and is turned off on this server")
    # Auth and limits run off the event loop: a presented key can wait on the shared lockout store (authguard).
    await run_in_threadpool(limit, request, "render_cached", per_hour=600)  # before any storage lookup
    photo = None
    if file is not None:
        if req.provider != "meta":  # an upload is stored and person-blurred with SAM: the paid path only
            raise HTTPException(400, "photo uploads need provider=meta and a judge or team key")
        if file.content_type not in {"image/jpeg", "image/png", "image/webp"}:
            raise HTTPException(415, "unsupported image type")
        raw = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(raw) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "image too large")
        from dryrun.meta import observe

        try:  # decode check, 40 MP cap, EXIF/GPS stripped, at most 1280 px: only these bytes are hashed, stored or sent
            _, photo = await run_in_threadpool(observe.prepare, raw)
        except ValueError:
            raise HTTPException(400, "unreadable or oversized image") from None
    try:
        rid, _ = await run_in_threadpool(R.key, req, photo)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    hit = R.load(rid)
    if hit is not None:
        return JSONResponse(hit.model_dump(mode="json"))
    if req.provider == "meta":  # three Muse Image calls: judge or team key, per-IP and daily caps
        await run_in_threadpool(require_paid_access, request)
        await run_in_threadpool(limit, request, "render", per_hour=int(os.getenv("DRYRUN_RENDER_PER_HOUR", "20")))
        await run_in_threadpool(limit_global, "render", per_day=int(os.getenv("DRYRUN_RENDER_PER_DAY", "100")),
                                request=request)
    else:
        await run_in_threadpool(limit, request, "render_fake", per_hour=120)
    try:
        res = await run_in_threadpool(R.make, req, photo)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    except R.PhotoCheckFailed:
        raise HTTPException(502, "Could not check the photo for people, so it was not used. Try again.") from None
    except R.Busy:
        raise HTTPException(409, "The same picture is being made right now. Try again in a minute.") from None
    except media.ImageRefused:
        raise HTTPException(422, "The image model's content filter declined this picture. Try another spot.") from None
    except RuntimeError:  # META_API_KEY unset on this deployment
        raise HTTPException(503, "the image model is not configured on this deployment") from None
    except httpx.HTTPError:
        raise HTTPException(502, "image model call failed; try again later") from None
    return JSONResponse(res.model_dump(mode="json"))


@router.get("/render/{render_id}")
def render_result(render_id: str, request: Request):
    from dryrun.meta import render as R

    if not _ID.fullmatch(render_id):
        raise HTTPException(400, "invalid render_id")
    limit(request, "render_cached", per_hour=600)
    res = R.load(render_id)
    if res is None:
        raise HTTPException(404, "not rendered")
    return JSONResponse(res.model_dump(mode="json"), headers={"Cache-Control": "private, max-age=86400"})


@router.get("/render/{render_id}/{name}.webp")
def render_image(render_id: str, name: str, request: Request):
    from dryrun.meta import render as R

    if not _ID.fullmatch(render_id) or name not in R.NAMES:
        raise HTTPException(404, "unknown picture")
    limit(request, "render_cached", per_hour=600)
    try:
        data = R.image(render_id, name)
    except Exception:  # noqa: BLE001 - missing object
        raise HTTPException(404, "not rendered") from None
    # an id is a hash of the request, so a picture never changes once written
    return Response(data, media_type="image/webp", headers={"Cache-Control": "private, max-age=31536000, immutable"})
