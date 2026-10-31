"""Muse Image before/after of one street spot in two runs of the same storm (owner: Eng A; Eng C reviews the
Meta calls in media.py).

first   the deeper of the two pictures, generated from text: what the AOI layers say about the spot (place, road,
        building density, nearby drains), that run's changes, and its peak water depth in the spot's grid cell. With
        the caller's own photo (EXIF stripped, private) it is an edit of that photo instead.
second  an edit of the first: less water (the other run's depth) and the changes swapped in or out.

Meta's content filter refuses most edits that add deep water to a picture but passes text-to-image at the same depth
and edits that take water away, so the deeper picture always comes first. One source picture keeps the camera and
buildings the same in both. The model draws water roughly and tends to draw less than asked, so Muse Spark vision
estimates the depth each picture shows (picture_depth_m), and the run's number and RENDER_LABEL are drawn into every
picture. Pictures are cached by render_id in private storage: a replay or a second viewer costs nothing.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from dryrun import storage
from dryrun.contracts import RenderImage, RenderRequest, RenderResult, RunManifest
from dryrun.contracts.schemas import RENDER_LABEL

RENDER_VERSION = "1"  # part of render_id: bump when the prompts change so cached pictures are re-made
MIN_WATER_M = 0.05  # below this in both runs there is nothing to show
WIDTH_PX = 1600
NAMES = ("photo", "before", "after")


# ------------------------------------------------------------------------ request -> runs, cell, cache key

def _cell(grid, lon: float, lat: float) -> tuple[int, int]:
    w, s, e, n = grid.bounds_wgs84
    col, row = math.floor((lon - w) / (e - w) * grid.nx), math.floor((n - lat) / (n - s) * grid.ny)
    if not (0 <= row < grid.ny and 0 <= col < grid.nx):
        raise ValueError("the spot is outside the area")
    return row, col


def runs(req: RenderRequest) -> tuple[RunManifest, RunManifest]:
    """Both runs, checked: done, same AOI, same storm and length, not the same run. Raises LookupError for an
    unknown run, ValueError otherwise."""
    if req.base_run_id == req.alt_run_id:
        raise ValueError("base_run_id and alt_run_id are the same run")
    for rid in (req.base_run_id, req.alt_run_id):
        if not storage.run_exists(rid):
            raise LookupError(f"unknown run {rid}")
    base, alt = storage.load_run(req.base_run_id), storage.load_run(req.alt_run_id)
    for m in (base, alt):
        if m.status.value != "done":
            raise ValueError(f"run {m.run_id} is {m.status.value}")
    if base.scenario.aoi_id != alt.scenario.aoi_id:
        raise ValueError("the two runs are on different areas")
    if (base.scenario.storm != alt.scenario.storm) or (base.scenario.sim_hours != alt.scenario.sim_hours):
        raise ValueError("the two runs have different storms: compare runs of the same storm")
    return base, alt


def render_id(req: RenderRequest, cell: tuple[int, int], photo_sha: str | None) -> str:
    key = {"base": req.base_run_id, "alt": req.alt_run_id, "cell": list(cell), "view": req.view,
           "provider": req.provider, "photo": photo_sha, "v": RENDER_VERSION}
    return "v_" + hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:16]


def key(req: RenderRequest, photo: bytes | None) -> tuple[str, tuple[int, int]]:
    """(render_id, cell) without any model call. Raises ValueError for a bad request."""
    base, _ = runs(req)
    cell = _cell(storage.load_aoi(base.scenario.aoi_id).grid, *req.center)
    return render_id(req, cell, hashlib.sha256(photo).hexdigest() if photo else None), cell


def _rel(rid: str, name: str) -> str:
    return f"render/{rid}/{name}"


CLAIM_S = 900  # a render takes 50-90 s, worst case 2 image calls x 2 attempts x 180 s plus vision; older = crashed
WAIT_S = 240  # how long an identical request waits for the first one (under the Cloud Run request timeout)
WAIT_POLL_S = 2.0


class Busy(Exception):
    """The same picture is being made by another request and did not finish in time."""


class PhotoCheckFailed(Exception):
    """SAM could not check an uploaded photo for people, so it is not used."""


def _claim(rid: str, me: str) -> bool:
    """Atomically claim render_id across instances (storage.update_json is a conditional write in GCS)."""
    got = {}

    def fn(cur):
        now = time.time()
        if cur and cur.get("owner") not in (None, me) and now - float(cur.get("t", 0)) < CLAIM_S:
            got["ok"] = False
            return cur
        got["ok"] = True
        return {"owner": me, "t": now}

    storage.update_json("uploads", _rel(rid, "claim.json"), fn)
    return got["ok"]


def _release(rid: str, me: str) -> None:
    storage.update_json("uploads", _rel(rid, "claim.json"),
                        lambda cur: {"owner": None, "t": 0} if cur and cur.get("owner") == me else cur)


def _wait(rid: str, timeout_s: float = WAIT_S) -> RenderResult:
    end = time.time() + timeout_s
    while time.time() < end:
        hit = load(rid)
        if hit is not None:
            return hit
        time.sleep(WAIT_POLL_S)
    raise Busy("the same picture is still being made")


def load(rid: str) -> RenderResult | None:
    try:
        res = RenderResult.model_validate_json(storage.read_upload(_rel(rid, "render.json")))
    except Exception:  # noqa: BLE001 - not rendered yet
        return None
    return res.model_copy(update={"cached": True})


def image(rid: str, name: str) -> bytes:
    if name not in NAMES:
        raise ValueError("unknown picture")
    return storage.read_upload(_rel(rid, f"{name}.webp"))


# ------------------------------------------------------------------------ what is at the spot

@dataclass
class Spot:
    aoi_id: str
    city: str          # lagos | nyc | texas | other
    area_name: str
    place: str | None
    road: bool
    buildings: int     # building cells within 2 cells
    drain: str | None  # nearest drain kind within 1 cell (open drain, covered drain, canal, ...)
    system: str | None  # the AOI's default drainage: open | closed | mixed | None
    cell_m: float


def _city(aoi_id: str) -> str:
    for c in ("lagos", "nyc", "texas"):
        if aoi_id.startswith(c):
            return c
    return "other"


def spot(aoi_id: str, cell: tuple[int, int], lon: float, lat: float) -> Spot:
    from dryrun.api import point
    from dryrun.sim import exposure

    m = storage.load_aoi(aoi_id)
    g = m.grid
    r, c = cell
    for layer, what in (("boundary_mask", "open water"), ("exclude_mask", "permanent water")):
        if layer in m.layers and storage.load_raster(aoi_id, layer)[r, c] > 0.5:
            raise ValueError(f"the spot is {what}: pick a street")
    flat = r * g.nx + c
    road = "roads_graph" in m.layers and bool(np.isin(flat, exposure.edge_arrays(aoi_id).flat))
    nb = 0
    if "buildings" in m.layers:
        _, cells = exposure.building_cells(aoi_id)
        if len(cells):
            nb = int(((np.abs(cells[:, 0] - r) <= 2) & (np.abs(cells[:, 1] - c) <= 2)).sum())
    drain = None
    if "drain_network" in m.layers:
        doc = json.loads(storage.load_aoi_file(aoi_id, "drain_network"))
        cells = np.asarray(doc["nodes"]["cell"], np.int64)
        rr, cc = np.divmod(cells, g.nx)
        near = np.flatnonzero((np.abs(rr - r) <= 1) & (np.abs(cc - c) <= 1))
        if len(near):
            kinds = [doc["nodes"]["channel"][i] for i in near]
            for k in ("canal", "stream", "covered", "drain", "ditch", "culvert", "gutter"):
                if k in kinds:
                    drain = k
                    break
    place = point._place(aoi_id, lon, lat)
    return Spot(aoi_id, _city(aoi_id), storage.display_name(m.name), place["name"] if place else None, road, nb,
                drain, m.drainage_default.system if m.drainage_default else None, min(g.dx_m, g.dy_m))


def depth_at(run_id: str, cell: tuple[int, int]) -> float:
    return max(0.0, round(float(storage.load_depth(run_id, "max_depth.npy")[cell]), 2))


# ------------------------------------------------------------------------ what changed between the runs

@dataclass
class Change:
    label: str          # for people: "Rain garden in Lekki Phase 1"
    visual: str | None  # for the image model, None when nothing is visible at the spot
    here: bool


def _near(mask: np.ndarray, cell: tuple[int, int], k: int) -> bool:
    r, c = cell
    return bool(mask[max(r - k, 0):r + k + 1, max(c - k, 0):c + k + 1].any())


def _area(iv) -> str:
    return f" in {iv.place}" if getattr(iv, "place", None) else " in the drawn area" if getattr(
        iv, "polygon", None) is not None else " (whole area)"


def _drain_visual(sp: Spot, factor: float, add: float) -> str | None:
    if sp.system == "closed" or (sp.system is None and sp.city == "nyc"):
        if factor > 1 or add > 0:
            return "larger, clean storm-drain catch basin grates at the kerb"
        return "the kerbside catch basin grates clogged with leaves and litter" if factor < 1 else None
    parts = []
    if factor > 1:
        parts.append(f"the roadside drain rebuilt wider and deeper (about {factor:g} times its capacity), clean "
                     "concrete with a steel grating over it")
    elif factor == 0:
        parts.append("the roadside drain filled in and gone")
    elif factor < 1:
        parts.append("the roadside drain narrowed and silted up")
    if add > 0:
        parts.append("a new covered concrete drain along the kerb with grated inlets every few metres")
    return "; ".join(parts) or None


def changes(base: RunManifest, alt: RunManifest, sp: Spot, cell: tuple[int, int]) -> list[Change]:
    from dryrun.contracts import DrainUpgrade, GreenInfrastructure, RetentionPond, RoadClosure, TideLevel
    from dryrun.sim import interventions

    grid = storage.load_aoi(sp.aoi_id).grid
    have = {json.dumps(iv.model_dump(mode="json"), sort_keys=True) for iv in base.scenario.interventions}
    out: list[Change] = []
    for iv in alt.scenario.interventions:
        if json.dumps(iv.model_dump(mode="json"), sort_keys=True) in have:
            continue
        if isinstance(iv, TideLevel):
            out.append(Change(f"Lagoon / sea level held at {iv.boundary_level_m:g} m", None, False))
            continue
        mask = interventions.area_mask(alt.scenario, grid, iv, default_all=isinstance(iv, DrainUpgrade))
        if isinstance(iv, DrainUpgrade):
            what = " and ".join(p for p in (f"drains x{iv.capacity_factor:g}" if iv.capacity_factor != 1 else "",
                                            f"new drains {iv.add_mm_h:g} mm/h" if iv.add_mm_h else "") if p)
            here = _near(mask, cell, 0)
            out.append(Change(f"{what.capitalize() or 'Drains unchanged'}{_area(iv)}",
                              _drain_visual(sp, iv.capacity_factor, iv.add_mm_h) if here else None, here))
        elif isinstance(iv, GreenInfrastructure):
            here = _near(mask, cell, 1)
            out.append(Change(f"Rain garden / green infrastructure{_area(iv)}",
                              "a planted rain garden (bioswale) of grasses and low shrubs along the road edge, and "
                              "permeable paving on the pavement" if here else None, here))
        elif isinstance(iv, RetentionPond):
            inside, near = _near(mask, cell, 0), _near(mask, cell, 3)
            visual = ("the spot is now the edge of a new retention pond with grassy banks" if inside else
                      "a new retention pond with grassy banks beside the street" if near else None)
            out.append(Change(f"Retention pond {iv.depth_m:g} m deep{_area(iv)}", visual, near))
        elif isinstance(iv, RoadClosure):
            here = _near(mask, cell, 0)
            out.append(Change(f"Road closed{_area(iv)} (routing only)",
                              "the road closed to traffic with barriers" if here else None, here))
    out += _drainage_changes(base, alt, sp)
    return out


def _drainage_changes(base: RunManifest, alt: RunManifest, sp: Spot) -> list[Change]:
    from dryrun.sim import drainage

    aoi = storage.load_aoi(sp.aoi_id)
    try:
        a, b = drainage.settings(base.scenario, aoi), drainage.settings(alt.scenario, aoi)
    except ValueError:
        return []
    if a is None or b is None:
        return []
    closed = b.system == "closed"
    out = []
    if b.blockage < a.blockage:
        out.append(Change(f"Drains cleared: blockage {a.blockage:.0%} -> {b.blockage:.0%}",
                          "the drains and grates cleared of plastic waste and silt", True))
    elif b.blockage > a.blockage:
        out.append(Change(f"Drains blocked: blockage {a.blockage:.0%} -> {b.blockage:.0%}",
                          "the drains and grates choked with plastic waste and silt", True))
    if b.capacity_mm_h != a.capacity_mm_h:
        up = b.capacity_mm_h > a.capacity_mm_h
        out.append(Change(f"Drain capacity {a.capacity_mm_h:g} -> {b.capacity_mm_h:g} mm/h",
                          _drain_visual(sp, 2.0 if up else 0.5, 0.0), True))
    if b.outfall != a.outfall:
        visual = None
        if b.outfall == "blocked":
            visual = ("water welling up out of the kerbside catch basin grates" if closed else
                      "the roadside drain brim-full and spilling onto the road")
        out.append(Change(f"Outfalls {a.outfall} -> {b.outfall}", visual, visual is not None))
    if b.flap_gates != a.flap_gates:
        out.append(Change(f"Flap gates on the outfalls {'added' if b.flap_gates else 'removed'}", None, False))
    if b.system != a.system:
        out.append(Change(f"Drainage system {a.system} -> {b.system}",
                          "storm-drain grates at the kerb over new sewers" if b.closed and not a.closed else None,
                          b.closed and not a.closed))
    if b.roadside_gutters != a.roadside_gutters:
        out.append(Change(f"Roadside drains {'added' if b.roadside_gutters else 'removed'}",
                          "an open concrete drain along the kerb" if b.roadside_gutters else None,
                          b.roadside_gutters))
    return out


# ------------------------------------------------------------------------ prompts

def depth_cue(d: float) -> str:
    """Object cues only (cars, kerbs, doors): references to people trip the content filter."""
    cm = round(d * 100)
    if d < 0.03:
        return "the street is wet after the rain with small puddles; no standing water"
    if d < 0.10:
        return f"a thin sheet of water {cm} cm deep over the road; the kerb still shows above it"
    if d < 0.20:
        return f"water {cm} cm deep: level with the top of the kerb, covering the bottom of the car tyres"
    if d < 0.35:
        return (f"water {cm} cm deep: the kerb and the roadside drain hidden under it, the water line halfway up the "
                "car tyres")
    if d < 0.60:
        return (f"water {cm} cm deep: the water line at the top of the car tyres and the bottom of the car doors, "
                "over the doorsteps")
    if d < 1.0:
        return (f"water {cm} cm deep: the water line at the car door handles, ground-floor doorways half under "
                "water")
    if d < 1.5:
        return f"water {cm} cm deep: cars under water up to their windows, the water at ground-floor window sills"
    return f"water over {cm} cm deep: cars almost under water, ground floors under water"


_SCENE = {
    "lagos": ("a residential street in {where}, Lagos, Nigeria: two- and three-storey concrete houses behind "
              "perimeter walls and steel gates, palm and almond trees, power poles"),
    "nyc": ("a residential street in {where}, Queens, New York City: two-storey attached brick row houses with front "
            "stoops and basement windows, street trees, parked cars"),
    "texas": "a road in {where}, in the Texas Hill Country: live oaks, limestone, cabins and low houses",
    "other": "a street in {where}",
}
_WATER = {"lagos": "muddy brown rainwater", "nyc": "murky grey-brown rainwater", "texas": "muddy brown floodwater",
          "other": "muddy rainwater"}
_DRAIN = {"drain": "an open concrete roadside drain along the kerb", "ditch": "an earth drainage ditch beside the road",
          "covered": "a roadside drain covered with concrete slabs", "gutter": "an open concrete roadside drain along "
          "the kerb", "canal": "a concrete drainage canal beside the road", "stream": "a small stream beside the road",
          "culvert": "a culvert under the road"}


def scene_prompt(sp: Spot, view: str, d: float, visuals: list[str]) -> str:
    """Text-to-image for the deeper of the two pictures (text generation passes the content filter at depths where
    an edit that adds water is refused)."""
    where = sp.place or sp.area_name
    parts = ["Illustration in a realistic style of " + _SCENE[sp.city].format(where=where) + ", after a heavy "
             "rainstorm."]
    if sp.road:
        parts.append("The street runs into the frame, with a parked car side-on in the near foreground.")
    else:
        parts.append("A side lane or open ground between buildings, with a car parked side-on in the near foreground.")
    parts.append("Open land with a few buildings in the distance." if sp.buildings == 0 else
                 "Detached houses with gaps between them." if sp.buildings <= 6 else
                 "Buildings close together on both sides.")
    if sp.system == "closed" or (sp.system is None and sp.city == "nyc"):
        parts.append("Include a storm-drain catch basin grate at the kerb.")  # closed sewers: no open channel
    elif sp.drain:
        parts.append(f"Include {_DRAIN[sp.drain]}.")
    if visuals:
        parts.append("Also show: " + "; ".join(visuals) + ".")
    parts.append("Seen from a first-floor window across the street, looking down." if view == "window" else
                 "Eye level from the street.")
    parts.append(depth_cue(d).capitalize() + "." if d < 0.03 else
                 f"{_WATER[sp.city].capitalize()} stands over the whole street: {depth_cue(d)}.")
    parts.append("Overcast sky. No people, no text, no logos, no watermark.")
    return " ".join(parts)


def edit_prompt(sp: Spot, d: float, add: list[str], remove: list[str], lower: bool) -> str:
    """Edit of the deeper picture into the other one: less (or the same) water, and the changes swapped."""
    parts = ["Illustration in a realistic style of the same street" + (" with less rainwater." if lower else ".")
             + " Keep the camera, buildings, walls, car and trees exactly the same."]
    if add:
        parts.append("Add: " + "; ".join(add) + ".")
    if remove:
        parts.append("Remove: " + "; ".join(remove) + ".")
    parts.append("The street is now only wet, with small puddles and no standing water." if d < 0.03 else
                 f"The water level is now: {depth_cue(d)}.")
    parts.append("No people, no text.")
    return " ".join(parts)


def photo_prompt(sp: Spot, d: float, visuals: list[str]) -> str:
    """Edit of the caller's own photo into the deeper picture (may be refused by the content filter when deep)."""
    parts = ["Illustration in a realistic style of the same street after a heavy rainstorm. Keep the camera, "
             "buildings and trees the same."]
    if visuals:
        parts.append("Add: " + "; ".join(visuals) + ".")
    parts.append(depth_cue(d).capitalize() + "." if d < 0.03 else
                 f"Add {_WATER[sp.city]} covering the road: {depth_cue(d)}.")
    parts.append("No people, no text.")
    return " ".join(parts)


# ------------------------------------------------------------------------ pictures

def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def label(raw: bytes, lines: list[str]) -> bytes:
    """Resize to WIDTH_PX and draw the label strip into the picture, so it survives screenshots."""
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    if img.width > WIDTH_PX:
        img = img.resize((WIDTH_PX, round(img.height * WIDTH_PX / img.width)), Image.LANCZOS)
    size = max(14, img.width // 60)
    font = _font(size)
    pad = size // 2
    strip = pad * 2 + len(lines) * (size + pad // 2)
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(over)
    draw.rectangle([0, img.height - strip, img.width, img.height], fill=(0, 0, 0, 170))
    for i, line in enumerate(lines):
        draw.text((pad, img.height - strip + pad + i * (size + pad // 2)), line, font=font, fill=(255, 255, 255, 255))
    out = io.BytesIO()
    Image.alpha_composite(img.convert("RGBA"), over).convert("RGB").save(out, format="WEBP", quality=85)
    return out.getvalue()


def matches(picture: float | None, d: float) -> bool | None:
    return None if picture is None else abs(picture - d) <= max(0.10, 0.35 * d)


class MetaImages:
    model = "muse-image-1.0"

    def generate(self, prompt: str, depth_m: float, visuals: list[str]) -> bytes:
        from dryrun.meta import media

        return media.generate_image(prompt)

    def edit(self, photo: bytes, prompt: str, depth_m: float, visuals: list[str]) -> bytes:
        from dryrun.meta import media

        return media.render_intervention(photo, prompt)

    def picture_depth(self, image: bytes) -> float | None:
        """Muse Spark vision on the finished picture (the same estimator as citizen photos)."""
        from dryrun.meta import observe

        try:
            _, jpeg = observe.prepare(image)
            est = observe.estimate_depth(jpeg, ["car"])["est_depth_m"]
        except Exception:  # noqa: BLE001 - the check is a bonus: a failed estimate leaves it unknown
            return None
        return None if est is None else round(float(est), 2)


class FakeImages:
    """Offline stand-in: a flat drawn street with a blue band as tall as the depth and a green strip for any change.
    No network, no cost (tests, UI work without keys)."""

    model = "fake"

    def _street(self) -> Image.Image:
        img = Image.new("RGB", (1536, 1024), (176, 184, 192))
        d = ImageDraw.Draw(img)
        d.rectangle([0, 560, 1536, 1024], fill=(90, 90, 96))  # road
        for x in range(40, 1536, 300):
            d.rectangle([x, 260, x + 220, 560], fill=(205, 196, 180))  # houses
        d.rectangle([180, 700, 560, 860], fill=(150, 160, 170))  # car
        return img

    def _draw(self, img: Image.Image, depth_m: float, visuals: list[str]) -> bytes:
        img = img.convert("RGBA")
        over = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(over)
        if visuals:
            d.rectangle([0, int(img.height * 0.52), img.width, int(img.height * 0.56)], fill=(60, 140, 70, 255))
        if depth_m >= 0.03:
            top = img.height - int(min(depth_m, 2.0) / 2.0 * img.height * 0.6) - int(img.height * 0.05)
            d.rectangle([0, top, img.width, img.height], fill=(70, 110, 160, 150))
        out = io.BytesIO()
        Image.alpha_composite(img, over).convert("RGB").save(out, format="PNG")
        return out.getvalue()

    def generate(self, prompt: str, depth_m: float, visuals: list[str]) -> bytes:
        return self._draw(self._street(), depth_m, visuals)

    def edit(self, photo: bytes, prompt: str, depth_m: float, visuals: list[str]) -> bytes:
        return self._draw(self._street(), depth_m, visuals)  # a fresh street, so bands never stack

    def picture_depth(self, image: bytes) -> float | None:
        return None


def backend(provider: str):
    return FakeImages() if provider == "fake" else MetaImages()


def _blurred(photo: bytes) -> bytes:
    """EXIF-stripped (observe.prepare) and every person SAM 3.1 finds blurred, before the photo is stored or sent to
    the image model. A failed check refuses the photo rather than passing faces on."""
    from dryrun.meta import observe

    img, jpeg = observe.prepare(photo)
    try:
        masks = observe.segment(jpeg, "person", img.size)
    except Exception as exc:  # noqa: BLE001 - any failure: do not use the photo
        raise PhotoCheckFailed("could not check the photo for people") from exc
    return observe._jpeg(observe.blur_people(img, masks))


def make(req: RenderRequest, photo: bytes | None = None) -> RenderResult:
    """Render (or return the cached) before/after. Identical requests in flight share one render (a claim per
    render_id); the second waits for the first. Raises ValueError for a bad request, Busy when the other render
    does not finish in time, media.ImageRefused when the content filter refuses, httpx errors when the model fails.

    photo: the upload after observe.prepare (EXIF stripped); render_id hashes these bytes, so the same photo again is
    a free cache hit. People are blurred (_blurred) only when a picture is actually made, before storing or sending.

    The deeper picture comes first, from text (or from the caller's photo), and the other one is an edit of it with
    less water: edits that add deep water are mostly refused by the content filter, edits that take water away are
    not, and starting both from one picture keeps the camera and buildings the same."""
    if photo is not None and req.provider != "meta":
        raise ValueError("photo uploads need provider=meta (people in them are blurred with SAM 3.1 first)")
    base, alt = runs(req)
    rid, cell = key(req, photo)
    hit = load(rid)
    if hit is not None:
        return hit
    me = uuid.uuid4().hex
    if not _claim(rid, me):  # an identical request is already paying for this picture: wait for it
        return _wait(rid)
    try:
        hit = load(rid)  # finished between the first look and the claim
        return hit if hit is not None else _make(req, photo, base, alt, rid, cell)
    finally:
        _release(rid, me)


def _make(req: RenderRequest, photo: bytes | None, base: RunManifest, alt: RunManifest, rid: str,
          cell: tuple[int, int]) -> RenderResult:
    aoi_id = base.scenario.aoi_id
    sp = spot(aoi_id, cell, *req.center)
    d0, d1 = depth_at(base.run_id, cell), depth_at(alt.run_id, cell)
    if max(d0, d1) < MIN_WATER_M:
        raise ValueError("no water at this spot in either run: pick a flooded street")
    ch = changes(base, alt, sp, cell)
    visuals = [c.visual for c in ch if c.here and c.visual]
    be = backend(req.provider)
    alt_first = d1 > d0  # the change made things worse here: draw "after" first
    first_d, second_d = (d1, d0) if alt_first else (d0, d1)
    first_vis = visuals if alt_first else []
    second_add, second_remove = ([], visuals) if alt_first else (visuals, [])
    prompts: dict[str, str] = {}
    first_name, second_name = ("after", "before") if alt_first else ("before", "after")
    if photo is not None:
        clean = _blurred(photo)
        prompts[first_name] = photo_prompt(sp, first_d, first_vis)
        first = be.edit(clean, prompts[first_name], first_d, first_vis)
    else:
        clean = None
        prompts[first_name] = scene_prompt(sp, req.view, first_d, first_vis)
        first = be.generate(prompts[first_name], first_d, first_vis)
    prompts[second_name] = edit_prompt(sp, second_d, second_add, second_remove, second_d < first_d)
    second = be.edit(first, prompts[second_name], second_d, visuals if not alt_first else [])
    pics = {first_name: first, second_name: second}
    with ThreadPoolExecutor(2) as pool:
        seen = dict(zip(("before", "after"), pool.map(be.picture_depth, (pics["before"], pics["after"]))))
    source = "uploaded" if photo is not None else "generated"
    where = "from your photo" if photo is not None else "a typical street here, not a photo of this spot"
    cell_txt = f"{sp.cell_m:.0f} m cell"

    def lines(run_id: str, d: float) -> list[str]:
        return [f"{RENDER_LABEL} · {where}",
                f"Dry Run model: {d:.2f} m peak water in this {cell_txt} · run {run_id}"]

    files = {"before": label(pics["before"], lines(base.run_id, d0)),
             "after": label(pics["after"], lines(alt.run_id, d1))}
    if clean is not None:
        buf = io.BytesIO()
        Image.open(io.BytesIO(clean)).save(buf, format="WEBP", quality=85)
        files["photo"] = buf.getvalue()
    for name, data in files.items():
        storage.write_upload(_rel(rid, f"{name}.webp"), data, "image/webp")
    url = lambda name: f"/api/render/{rid}/{name}.webp"  # noqa: E731

    def pic(name: str, run_id: str, d: float) -> RenderImage:
        return RenderImage(url=url(name), run_id=run_id, depth_m=d, depth_text=depth_cue(d),
                           picture_depth_m=seen[name], picture_matches=matches(seen[name], d))

    before, after = pic("before", base.run_id, d0), pic("after", alt.run_id, d1)
    notes = [f"Water depths are each run's peak in the {cell_txt} holding the spot (a cell average). The pictures are "
             "drawn by an image model: read the number, not the picture.",
             "The street is " + ("your photo." if photo is not None else
                                 "generated from the map layers (place, road, buildings, drains), not a photo of the "
                                 "spot.")]
    for im, name in ((before, "before"), (after, "after")):
        if im.picture_matches is False:
            notes.append(f"The {name} picture shows about {im.picture_depth_m:.2f} m of water (Muse Spark's estimate); "
                         f"the model's depth there is {im.depth_m:.2f} m.")
    if any(c.here and c.visual is None for c in ch):
        notes.append("Some changes at this spot (pipes, gates, levels) are not visible from the street.")
    res = RenderResult(
        render_id=rid, request=req, aoi_id=aoi_id, cell=cell, place=sp.place,
        photo=url("photo") if clean is not None else None, before=before, after=after,
        changes_here=[c.label for c in ch if c.here], changes_elsewhere=[c.label for c in ch if not c.here],
        source_photo=source, model=be.model, prompts=prompts, notes=notes)
    storage.write_upload(_rel(rid, "render.json"), res.model_dump_json().encode(), "application/json")
    return res
