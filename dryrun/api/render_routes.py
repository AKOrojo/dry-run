"""Muse Image before/after endpoint (owner: Eng B; Eng C reviews the Meta call).
Implementation goes in dryrun/meta/media.render_intervention."""

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from dryrun.api.ratelimit import limit

router = APIRouter(prefix="/api")


@router.post("/render")
async def render(request: Request, file: UploadFile = File(...), instruction: str = Form(..., max_length=300)):
    limit(request, "render", per_hour=20)  # Muse Image costs money
    # Output is ALWAYS watermarked "AI illustration - not engineering design". Upload -> private storage.
    raise HTTPException(501, "Eng B: Muse Image before/after lands Day 5")
