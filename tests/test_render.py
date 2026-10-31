"""Muse Image before/after (dryrun/meta/render.py, /api/render): cache, gating, the Meta call shape, honesty."""

import base64
import io
import os

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

os.environ["DRYRUN_STORAGE"] = "local"
os.environ["DRYRUN_SIM_BACKEND"] = "fake"

from dryrun import storage  # noqa: E402
from dryrun.api import ratelimit  # noqa: E402
from dryrun.api.main import app  # noqa: E402
from dryrun.contracts import RenderRequest, ScenarioSpec  # noqa: E402
from dryrun.meta import media  # noqa: E402
from dryrun.meta import render as R  # noqa: E402
from dryrun.pipeline import fixtures  # noqa: E402
from dryrun.sim import interventions  # noqa: E402
from dryrun.sim.engine import run_scenario  # noqa: E402

STORM = {"total_mm": 120, "duration_h": 1}
PLACE = "North Estate (synthetic)"


@pytest.fixture(autouse=True)
def local_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "MODE", "local")
    monkeypatch.setattr(storage, "LOCAL_DATA", tmp_path / "data")
    monkeypatch.setattr(storage, "LOCAL_RUNS", tmp_path / "runs")
    storage.clear_caches()
    storage._DONE_RUNS.clear()
    ratelimit._hits.clear()
    ratelimit._day.clear()
    monkeypatch.setattr(ratelimit, "_TEAM", "team")
    monkeypatch.setattr(ratelimit, "_JUDGE", "")

    def offline(*args, **kwargs):
        raise AssertionError("unexpected HTTP call")

    monkeypatch.setattr("httpx.post", offline)
    yield
    storage.clear_caches()
    storage._DONE_RUNS.clear()


@pytest.fixture
def pair():
    """A baseline and a run with green infrastructure in North Estate, and a wet street cell inside it."""
    fixtures.build()
    base = run_scenario(ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=STORM))
    alt = run_scenario(ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=STORM, interventions=[
        {"type": "green", "place": PLACE}, {"type": "drain_upgrade", "capacity_factor": 3.0}]))
    grid = storage.load_aoi(fixtures.AOI_ID).grid
    inside = interventions.polygon_mask(grid, interventions.place_polygon(fixtures.AOI_ID, PLACE))
    water = storage.load_raster(fixtures.AOI_ID, "exclude_mask") > 0.5
    d = np.where(inside & ~water, storage.load_depth(base.run_id, "max_depth.npy"), -1)
    r, c = np.unravel_index(int(np.argmax(d)), d.shape)
    assert d[r, c] >= R.MIN_WATER_M, "fixture needs a wet cell in the place"
    w, s, e, n = grid.bounds_wgs84
    lon, lat = w + (c + 0.5) * (e - w) / grid.nx, n - (r + 0.5) * (n - s) / grid.ny
    return base, alt, (int(r), int(c)), (lon, lat)


def form(base, alt, lonlat, **kw):
    return {"base_run_id": base.run_id, "alt_run_id": alt.run_id, "lon": lonlat[0], "lat": lonlat[1], **kw}


def webp(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    assert img.format == "WEBP"
    return img


def test_fake_render_end_to_end_and_cache(pair, monkeypatch):
    base, alt, cell, lonlat = pair
    calls = []
    real = R.FakeImages.generate
    monkeypatch.setattr(R.FakeImages, "generate", lambda self, p, d, v: calls.append(p) or real(self, p, d, v))
    with TestClient(app) as client:
        r = client.post("/api/render", data=form(base, alt, lonlat, provider="fake"))
        assert r.status_code == 200, r.text
        res = r.json()
        assert res["model"] == "fake" and res["source_photo"] == "generated" and not res["cached"]
        assert res["label"] == "AI illustration, not a measurement"
        assert tuple(res["cell"]) == cell and res["place"] == PLACE
        # the depths are the runs' own peak depths in that cell
        assert res["before"]["depth_m"] == R.depth_at(base.run_id, cell)
        assert res["after"]["depth_m"] == R.depth_at(alt.run_id, cell)
        assert any("Rain garden" in c for c in res["changes_here"])
        assert any("Drains x3" in c for c in res["changes_here"])  # no area = the whole AOI, so here too
        # the change lowered the water here, so "before" is drawn first from text and "after" is an edit of it
        assert res["before"]["depth_m"] >= res["after"]["depth_m"]
        assert "near foreground" in res["prompts"]["before"] and "Keep the camera" in res["prompts"]["after"]
        assert "bioswale" in res["prompts"]["after"] and "bioswale" not in res["prompts"]["before"]
        assert f"{round(res['before']['depth_m'] * 100)} cm" in res["prompts"]["before"]
        assert res["photo"] is None and res["before"]["picture_depth_m"] is None  # fake: no vision check
        for name in ("before", "after"):
            got = client.get(res[name]["url"])
            assert got.status_code == 200 and got.headers["content-type"] == "image/webp"
            assert webp(got.content).width <= R.WIDTH_PX
        # a replay (or a click elsewhere in the same cell) is served from the cache: no new picture is made
        again = client.post("/api/render", data=form(base, alt, lonlat, provider="fake"))
        assert again.status_code == 200 and again.json()["cached"] and again.json()["render_id"] == res["render_id"]
        assert len(calls) == 1
        assert client.get(f"/api/render/{res['render_id']}").json()["render_id"] == res["render_id"]


def test_changes_elsewhere_are_listed_not_drawn(pair):
    base, alt, _, _ = pair
    grid = storage.load_aoi(fixtures.AOI_ID).grid
    inside = interventions.polygon_mask(grid, interventions.place_polygon(fixtures.AOI_ID, PLACE))
    land = ~(storage.load_raster(fixtures.AOI_ID, "exclude_mask") > 0.5) & ~(
        storage.load_raster(fixtures.AOI_ID, "boundary_mask") > 0.5)
    far = tuple(int(v) for v in np.argwhere(land & ~inside)[-1])  # land away from the place (checked below)
    for dr in (-2, -1, 0, 1, 2):
        for dc in (-2, -1, 0, 1, 2):
            assert not inside[min(max(far[0] + dr, 0), grid.ny - 1), min(max(far[1] + dc, 0), grid.nx - 1)]
    sp = R.spot(fixtures.AOI_ID, far, 0.0, 0.0)
    ch = R.changes(base, alt, sp, far)
    green = [c for c in ch if "Rain garden" in c.label]
    assert green and not green[0].here and green[0].visual is None


def test_paid_render_needs_a_key_but_cache_hits_do_not(pair, monkeypatch):
    base, alt, _, lonlat = pair
    made = []
    monkeypatch.setattr(media, "generate_image", lambda p: made.append(p) or R.FakeImages().generate(p, 0.5, []))
    monkeypatch.setattr(media, "render_intervention", lambda photo, p: R.FakeImages().edit(photo, p, 0.5, []))
    monkeypatch.setattr(R.MetaImages, "picture_depth", lambda self, img: 0.0)
    with TestClient(app) as client:
        assert client.post("/api/render", data=form(base, alt, lonlat)).status_code == 403
        ok = client.post("/api/render", data=form(base, alt, lonlat), headers={"X-Team-Token": "team"})
        assert ok.status_code == 200 and ok.json()["model"] == "muse-image-1.0"
        hit = client.post("/api/render", data=form(base, alt, lonlat))  # no key: served from the cache
        assert hit.status_code == 200 and hit.json()["cached"]
    assert len(made) == 1


def test_daily_cap(pair, monkeypatch):
    base, alt, _, lonlat = pair
    monkeypatch.setenv("DRYRUN_RENDER_PER_DAY", "1")
    monkeypatch.setattr(ratelimit, "_JUDGE", "judge")  # the team token is exempt from caps by design
    monkeypatch.setattr(media, "generate_image", lambda p: R.FakeImages().generate(p, 0.5, []))
    monkeypatch.setattr(media, "render_intervention", lambda photo, p: R.FakeImages().edit(photo, p, 0.5, []))
    monkeypatch.setattr(R.MetaImages, "picture_depth", lambda self, img: None)
    key = {"X-Judge-Key": "judge"}
    with TestClient(app) as client:
        assert client.post("/api/render", data=form(base, alt, lonlat), headers=key).status_code == 200
        assert client.post("/api/render", data=form(base, alt, lonlat, view="window"), headers=key).status_code == 429


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (64, 32), (10, 20, 30)).save(out, format="PNG")
    return out.getvalue()


class _Resp:
    def __init__(self, status, body):
        self.status_code, self._body, self.headers = status, body, {}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError("x", request=None, response=None)


def test_meta_request_shape_and_filter_retry(monkeypatch):
    monkeypatch.setenv("META_API_KEY", "k")
    sent = []
    ok = _Resp(200, {"data": [{"b64_json": base64.b64encode(_png()).decode()}], "usage": {"total_tokens": 1}})
    refused = _Resp(400, {"error": {"code": "content_policy_violation"}})
    replies = [ok, refused, ok]

    def post(url, **kw):
        sent.append((url, kw))
        return replies.pop(0)

    monkeypatch.setattr("httpx.post", post)
    assert media.generate_image("a street") == _png()
    url, kw = sent[0]
    assert url.endswith("/images/generations") and kw["json"]["model"] == "muse-image-1.0"
    assert kw["headers"]["Authorization"] == "Bearer k" and kw["json"]["size"] == media.IMAGE_SIZE
    assert media.render_intervention(_png(), "add water") == _png()  # refused once, then passes
    url, kw = sent[2]
    assert url.endswith("/images/edits") and kw["files"]["image"][2] == "image/png"  # declared type = the bytes
    assert kw["data"]["prompt"] == "add water"
    replies[:] = [refused, refused]
    with pytest.raises(media.ImageRefused):
        media.render_intervention(b"RIFF\x00\x00\x00\x00WEBPVP8 ", "add water")
    assert sent[-1][1]["files"]["image"][2] == "image/webp"


def test_refusal_and_missing_key_map_to_clear_errors(pair, monkeypatch):
    base, alt, _, lonlat = pair

    def refuse(p):
        raise media.ImageRefused("no")

    key = {"X-Team-Token": "team"}
    with TestClient(app) as client:
        monkeypatch.setattr(media, "generate_image", refuse)
        r = client.post("/api/render", data=form(base, alt, lonlat), headers=key)
        assert r.status_code == 422 and "content filter" in r.json()["detail"]
        monkeypatch.delenv("META_API_KEY", raising=False)
        monkeypatch.setattr(media, "generate_image", lambda p: media._image_call("generations", json={}))
        assert client.post("/api/render", data=form(base, alt, lonlat, view="window"), headers=key).status_code == 503


def test_bad_requests(pair):
    base, alt, _, lonlat = pair
    other = run_scenario(ScenarioSpec(aoi_id=fixtures.AOI_ID, storm={"total_mm": 50, "duration_h": 1}))
    grid = storage.load_aoi(fixtures.AOI_ID).grid
    w, s, e, n = grid.bounds_wgs84
    with TestClient(app) as client:
        def post(**kw):
            return client.post("/api/render", data={**form(base, alt, lonlat, provider="fake"), **kw})

        assert post(alt_run_id=base.run_id).status_code == 400  # same run
        assert "different storms" in post(alt_run_id=other.run_id).json()["detail"]
        assert post(alt_run_id="r_0000000000000000").status_code == 404
        assert post(alt_run_id="../x").status_code == 422
        assert post(view="drone").status_code == 422
        assert post(lon=e + 1).status_code == 400  # outside the area
        assert client.get("/api/render/v_0000000000000000").status_code == 404
        assert client.get("/api/render/nope").status_code == 400
        assert client.get("/api/render/v_0000000000000000/secret.webp").status_code == 404


def test_dry_spot_is_refused(pair):
    base, alt, _, _ = pair
    dry = (storage.load_depth(base.run_id, "max_depth.npy") < 0.01) & (
        storage.load_depth(alt.run_id, "max_depth.npy") < 0.01) & ~(
        storage.load_raster(fixtures.AOI_ID, "exclude_mask") > 0.5)
    if not dry.any():
        pytest.skip("fixture storm wets every cell")
    r, c = np.argwhere(dry)[0]
    grid = storage.load_aoi(fixtures.AOI_ID).grid
    w, s, e, n = grid.bounds_wgs84
    req = RenderRequest(base_run_id=base.run_id, alt_run_id=alt.run_id, provider="fake",
                        center=(w + (c + 0.5) * (e - w) / grid.nx, n - (r + 0.5) * (n - s) / grid.ny))
    with pytest.raises(ValueError, match="no water"):
        R.make(req)


def test_depth_cues_are_monotone_and_people_free():
    cues = [R.depth_cue(d) for d in (0.0, 0.05, 0.15, 0.3, 0.5, 0.8, 1.2, 2.0)]
    assert len(set(cues)) == len(cues)
    assert all(w not in c for c in cues for w in ("knee", "waist", "ankle", "chest", "person", "people", "adult"))
    assert "30 cm" in R.depth_cue(0.30)


def test_label_is_drawn_into_the_picture():
    raw = R.FakeImages().generate("x", 0.0, [])
    out = webp(R.label(raw, ["AI illustration, not a measurement", "0.42 m"]))
    plain = Image.open(io.BytesIO(raw)).convert("RGB").resize(out.size)
    # the label strip darkens the bottom of the picture
    assert np.asarray(out.convert("L"))[-5:].mean() < np.asarray(plain.convert("L"))[-5:].mean()


def test_worse_change_draws_after_first(pair):
    """Swap the runs: the change now raises the water, so "after" is generated and "before" edited from it."""
    base, alt, cell, lonlat = pair
    if R.depth_at(base.run_id, cell) <= R.depth_at(alt.run_id, cell):
        pytest.skip("the change does not lower the water at this cell")
    res = R.make(RenderRequest(base_run_id=alt.run_id, alt_run_id=base.run_id, center=lonlat, provider="fake"))
    assert "near foreground" in res.prompts["after"] and "Keep the camera" in res.prompts["before"]
    assert "with less rainwater" in res.prompts["before"]


def test_vision_check_reports_a_picture_that_shows_too_little_water(pair, monkeypatch):
    base, alt, cell, lonlat = pair
    monkeypatch.setattr(R.FakeImages, "picture_depth", lambda self, img: 0.01)
    res = R.make(RenderRequest(base_run_id=base.run_id, alt_run_id=alt.run_id, center=lonlat, provider="fake"))
    d0 = res.before.depth_m
    assert res.before.picture_depth_m == 0.01
    assert res.before.picture_matches is (abs(0.01 - d0) <= max(0.10, 0.35 * d0))
    if not res.before.picture_matches:
        assert any("Muse Spark" in n and f"{d0:.2f} m" in n for n in res.notes)
    assert R.matches(None, 0.5) is None and R.matches(0.45, 0.5) and not R.matches(0.2, 0.8)


def test_closed_sewer_streets_get_a_catch_basin_not_an_open_drain():
    sp = R.Spot("nyc-queens-v1", "nyc", "Queens", "Woodside", True, 10, "gutter", "closed", 15.0)
    p = R.scene_prompt(sp, "street", 0.4, [])
    assert "catch basin grate" in p and "open concrete" not in p and "Woodside, Queens" in p
    lagos = R.Spot("lagos-lekki-v3", "lagos", "Lekki", "Lekki Phase 1", True, 10, "drain", "open", 30.0)
    assert "open concrete roadside drain" in R.scene_prompt(lagos, "street", 0.4, [])


def test_identical_requests_in_flight_pay_once(pair, monkeypatch):
    import threading

    base, alt, _, lonlat = pair
    calls = []
    real = R.FakeImages.generate

    def slow(self, p, d, v):
        calls.append(p)
        threading.Event().wait(0.5)  # long enough for the second request to arrive mid-render
        return real(self, p, d, v)

    monkeypatch.setattr(R.FakeImages, "generate", slow)
    monkeypatch.setattr(R, "WAIT_POLL_S", 0.05)
    req = RenderRequest(base_run_id=base.run_id, alt_run_id=alt.run_id, center=lonlat, provider="fake")
    out = []
    threads = [threading.Thread(target=lambda: out.append(R.make(req))) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1 and len({r.render_id for r in out}) == 1 and sum(r.cached for r in out) == 2


def test_stale_claim_is_taken_over_and_a_live_one_is_busy(pair, monkeypatch):
    base, alt, cell, lonlat = pair
    req = RenderRequest(base_run_id=base.run_id, alt_run_id=alt.run_id, center=lonlat, provider="fake")
    rid, _ = R.key(req, None)
    storage.update_json("uploads", R._rel(rid, "claim.json"), lambda cur: {"owner": "crashed", "t": 0})
    assert not R.make(req).cached  # a claim older than CLAIM_S does not block
    req2 = req.model_copy(update={"view": "window"})
    rid2, _ = R.key(req2, None)
    import time

    storage.update_json("uploads", R._rel(rid2, "claim.json"), lambda cur: {"owner": "other", "t": time.time()})
    monkeypatch.setattr(R, "_wait", lambda rid: (_ for _ in ()).throw(R.Busy("busy")))
    with TestClient(app) as client:
        r = client.post("/api/render", data=form(base, alt, lonlat, provider="fake", view="window"))
        assert r.status_code == 409


@pytest.fixture
def paid_upload(monkeypatch):
    """Meta image calls and SAM replaced offline; returns the person boxes SAM 'finds' (editable per test)."""
    from dryrun.meta import observe

    monkeypatch.setattr(media, "generate_image", lambda p: R.FakeImages().generate(p, 0.5, []))
    monkeypatch.setattr(media, "render_intervention", lambda photo, p: R.FakeImages().edit(photo, p, 0.5, []))
    monkeypatch.setattr(R.MetaImages, "picture_depth", lambda self, img: None)
    sent = []
    boxes = [(100, 100, 300, 400)]  # x0, y0, x1, y1 in the prepared (<= 1280 px) photo

    def segment(jpeg, phrase, size):
        sent.append(phrase)
        masks = []
        for x0, y0, x1, y1 in boxes:
            m = np.zeros((size[1], size[0]), bool)
            m[y0:y1, x0:x1] = True
            masks.append(m)
        return masks

    monkeypatch.setattr(observe, "segment", segment)
    return {"sent": sent, "boxes": boxes}


def _noisy_jpeg(w=3000, h=2000, exif=None) -> bytes:
    rng = np.random.default_rng(1)
    out = io.BytesIO()
    Image.fromarray(rng.integers(0, 255, (h, w, 3), dtype=np.uint8)).save(out, format="JPEG", quality=95,
                                                                         **({"exif": exif} if exif else {}))
    return out.getvalue()


def test_uploads_are_paid_only(pair):
    base, alt, _, lonlat = pair
    with TestClient(app) as client:
        r = client.post("/api/render", data=form(base, alt, lonlat, provider="fake"),
                        files={"file": ("x.jpg", _noisy_jpeg(400, 300), "image/jpeg")})
        assert r.status_code == 400 and "provider=meta" in r.json()["detail"]
        r = client.post("/api/render", data=form(base, alt, lonlat),
                        files={"file": ("x.jpg", _noisy_jpeg(400, 300), "image/jpeg")})
        assert r.status_code == 403  # meta without a key


def test_uploaded_photo_is_stripped_and_people_are_blurred(pair, paid_upload):
    base, alt, _, lonlat = pair
    exif = Image.Exif()
    exif[0x8825] = {2: (6.0, 27.0, 0.0), 4: (3.0, 28.0, 0.0)}  # GPSInfo: latitude, longitude
    exif[0x010F] = "PhoneMaker"
    key = {"X-Team-Token": "team"}
    with TestClient(app) as client:
        bad = client.post("/api/render", data=form(base, alt, lonlat), headers=key,
                          files={"file": ("x.jpg", b"not an image", "image/jpeg")})
        assert bad.status_code == 400
        gif = client.post("/api/render", data=form(base, alt, lonlat), headers=key,
                          files={"file": ("x.gif", b"GIF89a", "image/gif")})
        assert gif.status_code == 415
        up = client.post("/api/render", data=form(base, alt, lonlat), headers=key,
                         files={"file": ("x.jpg", _noisy_jpeg(exif=exif), "image/jpeg")})
        assert up.status_code == 200, up.text
        res = up.json()
        assert res["source_photo"] == "uploaded" and paid_upload["sent"] == ["person"]
        assert "near foreground" not in res["prompts"]["before"]  # an edit of the photo, not text-to-image
        stored = Image.open(io.BytesIO(client.get(res["photo"]).content))
        assert max(stored.size) <= 1280 and not stored.getexif() and "exif" not in stored.info
        px = np.asarray(stored.convert("L"), float)
        x0, y0, x1, y1 = paid_upload["boxes"][0]
        inside, outside = px[y0 + 40:y1 - 40, x0 + 40:x1 - 40], px[y0:y1, x1 + 100:x1 + 300]
        assert inside.std() < 0.5 * outside.std()  # the person box is blurred, the rest is not
        # the same photo again is a cache hit: no second SAM call
        again = client.post("/api/render", data=form(base, alt, lonlat),
                            files={"file": ("x.jpg", _noisy_jpeg(exif=exif), "image/jpeg")})
        assert again.status_code == 200 and again.json()["cached"] and paid_upload["sent"] == ["person"]


def test_failed_person_check_refuses_the_photo(pair, paid_upload, monkeypatch):
    from dryrun.meta import observe

    base, alt, _, lonlat = pair

    def broken(*a, **k):
        raise RuntimeError("sam down")

    monkeypatch.setattr(observe, "segment", broken)
    with TestClient(app) as client:
        r = client.post("/api/render", data=form(base, alt, lonlat), headers={"X-Team-Token": "team"},
                        files={"file": ("x.jpg", _noisy_jpeg(400, 300), "image/jpeg")})
        assert r.status_code == 502 and "people" in r.json()["detail"]
    assert not list((storage.LOCAL_DATA / "_uploads" / "render").rglob("photo.webp"))  # nothing stored



def test_url_answers_must_be_https(monkeypatch):
    import httpx

    monkeypatch.setenv("META_API_KEY", "k")
    monkeypatch.setattr("httpx.post", lambda url, **kw: _Resp(200, {"data": [{"url": "http://example.com/a.png"}]}))
    with pytest.raises(httpx.HTTPError):
        media.generate_image("a street")
