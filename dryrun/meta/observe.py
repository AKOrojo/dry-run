"""Crowd/drone/satellite images -> private, anonymised Observation pins.

Run SAM 3.1 once per noun phrase, then estimate depth from reference objects
with vision. Strip EXIF, blur person boxes, and attach active-run depth.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import re

import httpx
import meta_sam_parser as m
import numpy as np
from PIL import Image, ImageFilter, ImageOps

from dryrun import storage
from dryrun.contracts import Observation
from dryrun.meta.providers import DEFAULTS, OpenAICompatProvider

SAM_MODEL = "sam-3.1"
PROMPTS = ("flood water", "car", "person", "door")
MAX_PIXELS = 40_000_000


def _post(path: str, body: dict) -> dict:
    provider = OpenAICompatProvider("meta")
    response = httpx.post(f"{provider.base_url.rstrip('/')}{path}", json=body, timeout=90,
                          headers={"Authorization": f"Bearer {provider.key}"})
    response.raise_for_status()
    return response.json()


def _jpeg(img: Image.Image) -> bytes:
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=88, exif=b"")
    return out.getvalue()


def prepare(image_bytes: bytes) -> tuple[Image.Image, bytes]:
    try:
        with Image.open(io.BytesIO(image_bytes)) as original:
            if original.width * original.height > MAX_PIXELS:
                raise ValueError("image exceeds 40 MP")
            img = ImageOps.exif_transpose(original).convert("RGB")
            img.thumbnail((1280, 1280))
            img.info.clear()
            return img, _jpeg(img)
    except (OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("unreadable or oversized image") from exc


def _masks_from_sam_text(text: str, size: tuple[int, int]) -> list[np.ndarray]:
    if not text.strip():
        return []
    parser = m.image_segmentation_format().create_parser()
    parser.push(text)
    result = parser.finish(m.CompletedOutcome()).result
    masks = []
    width, height = size
    for rec in result.records:
        if rec.kind != "mask":
            continue
        raster = np.frombuffer(m.decode_mask_to_raster(rec.mask), dtype=np.uint8)
        raster = raster.reshape(rec.mask.height, rec.mask.width)
        left, top, right, bottom = (int(getattr(rec.bounds, key)) for key in ("left", "top", "right", "bottom"))
        if right <= left or bottom <= top:
            continue
        box = Image.fromarray(raster).resize((right - left, bottom - top), Image.Resampling.NEAREST)
        x0, y0, x1, y1 = max(0, left), max(0, top), min(width, right), min(height, bottom)
        if x0 >= x1 or y0 >= y1:
            continue
        mask = np.zeros((height, width), dtype=bool)
        mask[y0:y1, x0:x1] = np.asarray(box)[y0 - top:y1 - top, x0 - left:x1 - left] != 0
        masks.append(mask)
    return masks


def _image_url(jpeg_bytes: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes).decode()


def segment(jpeg_bytes: bytes, phrase: str, size: tuple[int, int]) -> list[np.ndarray]:
    response = _post("/responses", {"model": SAM_MODEL, "store": False, "input": [{
        "role": "user", "content": [{"type": "input_text", "text": phrase},
                                    {"type": "input_image", "image_url": _image_url(jpeg_bytes)}]}]})
    return _masks_from_sam_text(response["output"][0]["content"][0]["text"], size)


def blur_people(img: Image.Image, masks: list[np.ndarray]) -> Image.Image:
    out = img.copy()
    for mask in masks:
        ys, xs = np.nonzero(mask)
        if not len(xs):
            continue
        width, height = int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)
        dx, dy = math.ceil(width * .1), math.ceil(height * .1)
        box = (max(0, int(xs.min()) - dx), max(0, int(ys.min()) - dy),
               min(img.width, int(xs.max()) + 1 + dx), min(img.height, int(ys.max()) + 1 + dy))
        out.paste(img.crop(box).filter(ImageFilter.GaussianBlur(max(8, max(width, height) * .1))), box)
    return out


def estimate_depth(jpeg_bytes: bytes, found: list[str]) -> dict:
    properties = {key: {"type": ["number", "null"]} for key in ("est_depth_m", "low", "high")}
    properties.update(reference_object={"type": ["string", "null"]}, notes={"type": "string"})
    prompt = ("Estimate flood water depth in metres. Reference sizes: car tyre ~0.65 m diameter, "
              "door ~2.0 m, adult knee ~0.5 m. SAM found: " + (", ".join(found) or "none") +
              ". Return est_depth_m, low, high, reference_object and notes. "
              "Use null for depths and reference_object if depth cannot be judged.")
    body = {"model": DEFAULTS["meta"]["model"], "max_tokens": 1500,
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt},
                     {"type": "image_url", "image_url": {"url": _image_url(jpeg_bytes)}}]}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "depth", "schema": {
            "type": "object", "properties": properties, "required": list(properties),
            "additionalProperties": False}}}}
    for _ in range(2):  # the model intermittently returns content=None with finish_reason=stop
        try:
            data = json.loads(_post("/chat/completions", body)["choices"][0]["message"]["content"] or "")
            if isinstance(data, dict):
                break
        except ValueError:
            pass
    else:
        return {"est_depth_m": None, "low": None, "high": None, "reference_object": None,
                "notes": "depth model returned no usable answer"}
    for key in ("est_depth_m", "low", "high"):
        value = data.get(key)
        data[key] = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 5 else None
    if data["low"] is not None and data["high"] is not None:
        data["low"], data["high"] = sorted((data["low"], data["high"]))
        if data["est_depth_m"] is not None:
            data["low"], data["est_depth_m"], data["high"] = sorted(
                (data["low"], data["est_depth_m"], data["high"]))
    data["notes"] = str(data.get("notes") or "")[:300]
    data["reference_object"] = str(data["reference_object"])[:40] if data.get("reference_object") else None
    return data


def _sim_depth(run_id: str, lon: float, lat: float) -> float | None:
    if not re.fullmatch(r"r_[0-9a-f]{16}", run_id):
        return None
    try:
        manifest = storage.load_run(run_id)
        grid = storage.load_aoi(manifest.scenario.aoi_id).grid
        w, s, e, n = grid.bounds_wgs84
        col, row = math.floor((lon - w) / (e - w) * grid.nx), math.floor((n - lat) / (n - s) * grid.ny)
        if 0 <= row < grid.ny and 0 <= col < grid.nx:
            return round(float(storage.load_depth(run_id, "max_depth.npy")[row, col]), 3)
    except Exception:
        return None
    return None


def observe(image_bytes: bytes, lon: float, lat: float, t_s: int | None, source: str,
            run_id: str | None = None) -> Observation:
    img, jpeg = prepare(image_bytes)
    masks = {phrase: segment(jpeg, phrase, img.size) for phrase in PROMPTS}
    water = np.zeros((img.height, img.width), dtype=bool)
    for mask in masks["flood water"]:
        water |= mask
    fraction = float(np.clip(water.mean(), 0, 1))
    photo = _jpeg(blur_people(img, masks["person"]))
    depth = estimate_depth(photo, [p for p in PROMPTS if masks[p]]) if fraction > .01 else {
        "est_depth_m": None, "low": None, "high": None, "reference_object": None,
        "notes": "no flood water detected"}
    obs_id = "ob_" + hashlib.sha256(jpeg).hexdigest()[:12]
    observation = Observation(obs_id=obs_id, lon=lon, lat=lat, t_s=t_s, source=source,
        est_depth_m=depth["est_depth_m"], depth_low_m=depth["low"], depth_high_m=depth["high"],
        reference_object=depth["reference_object"], water_fraction=fraction,
        mask_png=f"/api/observations/{obs_id}/mask.png", model_notes=depth["notes"],
        sim_depth_m=_sim_depth(run_id, lon, lat) if run_id else None)
    if fraction <= .01:
        # No flood water: nothing to show on the map, so a resident's photo of a dry street is not kept at all.
        return observation
    overlay = np.zeros((img.height, img.width, 4), dtype=np.uint8)
    overlay[water] = (0, 100, 255, 128)
    png = io.BytesIO()
    Image.fromarray(overlay).save(png, format="PNG")
    prefix = f"observations/{obs_id}"
    storage.write_upload(f"{prefix}/photo.jpg", photo, "image/jpeg")
    storage.write_upload(f"{prefix}/mask.png", png.getvalue(), "image/png")
    storage.write_upload(f"{prefix}/observation.json", observation.model_dump_json().encode(), "application/json")
    return observation
