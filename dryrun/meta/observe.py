"""Crowd/drone/satellite observations -> Observation pins (owner: Eng C).

Pipeline:  image (+lon/lat, +time) -> SAM 3.1 masks for ONE noun phrase per request
("flood water", then "car", then "person", then "door")  -> Muse Spark vision estimates
water depth from reference objects (tyre ~0.65 m dia, door ~2.0 m, adult knee ~0.5 m)
-> Observation with low/high band  -> backend fills sim_depth_m from the active run.

Gotchas (from Meta docs, re-check Day 1):
- SAM 3.1 concept prompt = ONE noun phrase. "car, person" returns nothing.
- SAM 3.1 output is special-token text: parse with Meta's SAM parser library (exact PyPI name: confirm
  on dev.meta.ai before adding it to the `meta` extra; the Docker build installs that extra).
- Video: MP4/MOV only, <= 15,000 frames, <= 16 tracked objects/frame.
- Use STANDARD (not contributor) mode for any user-uploaded photo.
- Strip EXIF except GPS/time before storing; never store faces (blur 'person' masks).
"""

from __future__ import annotations

SAM_MODEL = "sam-3.1"
PROMPTS = ("flood water", "car", "person", "door")


def segment(image_bytes: bytes, phrase: str) -> dict:
    """POST /v1/responses with model sam-3.1; returns parsed masks. TODO Eng C Day 3."""
    raise NotImplementedError


def estimate_depth(image_bytes: bytes, masks: dict) -> dict:
    """Muse Spark vision with structured output {est_depth_m, low, high, reference_object, notes}."""
    raise NotImplementedError


def observe(image_bytes: bytes, lon: float, lat: float, t_s: int | None, source: str):
    """Returns dryrun.contracts.Observation. TODO Eng C Day 3-5."""
    raise NotImplementedError
