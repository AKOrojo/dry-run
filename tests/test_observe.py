"""Offline photo observation pipeline and upload guardrails."""

import io
import json
import os
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

os.environ["DRYRUN_STORAGE"] = "local"
os.environ["DRYRUN_SIM_BACKEND"] = "fake"

from dryrun import storage  # noqa: E402
from dryrun.api import agent_routes, ratelimit  # noqa: E402
from dryrun.api.main import app  # noqa: E402
from dryrun.contracts import Observation, ScenarioSpec  # noqa: E402
from dryrun.meta import observe  # noqa: E402
from dryrun.pipeline import fixtures  # noqa: E402
from dryrun.sim.engine import run_scenario  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def local_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "MODE", "local")
    monkeypatch.setattr(storage, "LOCAL_DATA", tmp_path / "data")
    monkeypatch.setattr(storage, "LOCAL_RUNS", tmp_path / "runs")
    storage.clear_caches()
    ratelimit._hits.clear()
    ratelimit._day.clear()
    monkeypatch.setattr(ratelimit, "_TEAM", "team")
    monkeypatch.setattr(ratelimit, "_JUDGE", "")

    def offline(*args, **kwargs):
        raise AssertionError("unexpected HTTP call")

    monkeypatch.setattr(observe.httpx, "post", offline)
    yield
    storage.clear_caches()


@pytest.fixture
def sam_text():
    return storage.read_local_file(FIXTURES / "sam_red_circle.txt").decode()


@pytest.fixture
def photo():
    return storage.read_local_file(FIXTURES / "sam_red_circle.jpg")


def encode(img, **kwargs):
    out = io.BytesIO()
    img.save(out, format="JPEG", **kwargs)
    return out.getvalue()


def test_sam_mask(sam_text):
    masks = observe._masks_from_sam_text(sam_text, (256, 256))
    assert len(masks) == 1
    mask = masks[0]
    assert mask.dtype == bool and mask.shape == (256, 256)
    ys, xs = np.nonzero(mask)
    assert (xs.min(), ys.min(), xs.max(), ys.max()) == pytest.approx((90, 60, 170, 140), abs=2)
    assert .07 < mask.mean() < .09
    assert observe._masks_from_sam_text("", (256, 256)) == []


def test_prepare(monkeypatch):
    img = Image.new("RGB", (3000, 2000), "red")
    exif = Image.Exif()
    exif[34853] = {1: "N", 2: (6., 27., 0.)}
    prepared, jpeg = observe.prepare(encode(img, exif=exif))
    assert max(prepared.size) == 1280 and prepared.mode == "RGB"
    assert not Image.open(io.BytesIO(jpeg)).getexif()
    with pytest.raises(ValueError):
        observe.prepare(b"not an image")
    monkeypatch.setattr(observe, "MAX_PIXELS", 10)
    with pytest.raises(ValueError):
        observe.prepare(encode(Image.new("RGB", (4, 4))))


def test_blur_people():
    arr = np.random.default_rng(5).integers(0, 256, (100, 100, 3), dtype=np.uint8)
    mask = np.zeros((100, 100), bool)
    mask[30:60, 30:60] = True
    blurred = np.asarray(observe.blur_people(Image.fromarray(arr), [mask]))
    assert not np.array_equal(blurred[30:60, 30:60], arr[30:60, 30:60])
    assert np.array_equal(blurred[:20], arr[:20])
    assert np.array_equal(blurred[:, :20], arr[:, :20])


def depth_response(est=1.2, low=.8, high=1.6):
    return {"choices": [{"message": {"content": json.dumps({"est_depth_m": est, "low": low,
        "high": high, "reference_object": "door" * 20, "notes": "n" * 400})}}]}


@pytest.mark.parametrize("est,low,high,expected", [(9, 4, 1, (None, 1, 4)), (2, 4, 1, (2, 1, 4)),
                                                   (4, 1, 2, (2, 1, 4))])
def test_depth_sanitising(monkeypatch, est, low, high, expected):
    def post(path, body):
        assert path == "/chat/completions"
        assert body["max_tokens"] == 1500
        assert body["response_format"]["json_schema"]["name"] == "depth"
        return depth_response(est, low, high)

    monkeypatch.setattr(observe, "_post", post)
    result = observe.estimate_depth(b"jpeg", ["door"])
    assert (result["est_depth_m"], result["low"], result["high"]) == expected
    assert len(result["notes"]) == 300 and len(result["reference_object"]) == 40


@pytest.mark.parametrize("wet", [True, False])
def test_observe(monkeypatch, sam_text, photo, wet):
    calls = []

    def post(path, body):
        calls.append((path, body))
        if path == "/chat/completions":
            assert wet
            return depth_response()
        assert body["store"] is False and body["model"] == "sam-3.1"
        phrase = body["input"][0]["content"][0]["text"]
        return {"output": [{"content": [{"text": sam_text if wet and phrase == "flood water" else ""}]}]}

    monkeypatch.setattr(observe, "_post", post)
    result = observe.observe(photo, 3.5, 6.45, None, "citizen_photo")
    import re

    assert re.fullmatch(r"ob_[0-9a-f]{12}", result.obs_id)
    # A dry photo stores no mask, so it points at none (the URL would 404).
    assert result.mask_png == (f"/api/observations/{result.obs_id}/mask.png" if wet else None)
    assert result.water_fraction == pytest.approx(.078 if wet else 0, abs=.01)
    assert [b["input"][0]["content"][0]["text"] for p, b in calls if p == "/responses"] == list(observe.PROMPTS)
    if wet:
        assert (result.est_depth_m, result.depth_low_m, result.depth_high_m) == (1.2, .8, 1.6)
    else:
        assert result.est_depth_m is None and result.model_notes == "no flood water detected"
        assert all(path != "/chat/completions" for path, _ in calls)
        # A photo without flood water writes nothing: no photo, mask or record in storage.
        assert not any(p.is_file() for p in storage.LOCAL_DATA.rglob("*"))
        assert not any(p.is_file() for p in storage.LOCAL_RUNS.rglob("*"))
        return
    prefix = f"observations/{result.obs_id}"
    assert not Image.open(io.BytesIO(storage.read_upload(f"{prefix}/photo.jpg"))).getexif()
    mask = Image.open(io.BytesIO(storage.read_upload(f"{prefix}/mask.png")))
    assert mask.mode == "RGBA"
    assert np.count_nonzero(np.asarray(mask)[:, :, 3]) / (256 * 256) == result.water_fraction
    assert Observation.model_validate_json(storage.read_upload(f"{prefix}/observation.json")) == result


def test_sim_depth():
    fixtures.build()
    run = run_scenario(ScenarioSpec(aoi_id=fixtures.AOI_ID, storm={"total_mm": 120, "duration_h": 1}))
    grid = storage.load_aoi(fixtures.AOI_ID).grid
    w, s, e, n = grid.bounds_wgs84
    assert isinstance(observe._sim_depth(run.run_id, (w + e) / 2, (s + n) / 2), float)
    assert observe._sim_depth(run.run_id, e + 1, n + 1) is None
    assert observe._sim_depth("../bad", w, s) is None
    assert observe._sim_depth("r_0000000000000000", w, s) is None


def test_routes(monkeypatch, photo):
    fixed = Observation(obs_id="ob_012345abcdef", lon=3.5, lat=6.45, source="citizen_photo",
                        est_depth_m=None, water_fraction=0)
    received = []

    def run(*args):
        received.append(args)
        return fixed

    monkeypatch.setattr(observe, "observe", run)
    with TestClient(app) as client:
        def post(headers=None, content_type="image/jpeg", **data):
            return client.post("/api/observe", headers=headers,
                data={"lon": 3.5, "lat": 6.45, **data}, files={"file": ("photo", photo, content_type)})

        team = {"X-Team-Token": "team"}
        assert post().status_code == 403
        assert post(team, "text/plain").status_code == 415
        assert post(team, lat=200).status_code == 400
        assert post(team, source="bad").status_code == 400
        assert post(team, run_id="../bad").status_code == 400
        monkeypatch.setattr(agent_routes, "MAX_UPLOAD_BYTES", 1)
        assert post(team).status_code == 413
        monkeypatch.setattr(agent_routes, "MAX_UPLOAD_BYTES", len(photo))
        response = post(team, t_s=12, source="drone_video", run_id="r_0123456789abcdef")
        assert response.status_code == 200 and response.json()["obs_id"] == fixed.obs_id
        assert received[0][3:] == (12, "drone_video", "r_0123456789abcdef")
        assert client.get("/api/observations/bad/mask.png").status_code == 404
        assert client.get(f"/api/observations/{fixed.obs_id}/mask.png").status_code == 404
        storage.write_upload(f"observations/{fixed.obs_id}/mask.png", b"png", "image/png")
        response = client.get(f"/api/observations/{fixed.obs_id}/mask.png")
        assert response.status_code == 200 and response.headers["content-type"] == "image/png"


def test_estimate_depth_survives_empty_model_answers(monkeypatch):
    calls = []

    def post(path, body):
        calls.append(path)
        return {"choices": [{"message": {"content": None}}]}

    monkeypatch.setattr(observe, "_post", post)
    out = observe.estimate_depth(b"jpeg", ["flood water"])
    assert len(calls) == 2 and out["est_depth_m"] is None and "no usable answer" in out["notes"]
