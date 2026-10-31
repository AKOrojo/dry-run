"""GET /api/aoi/{id}/observations: stored observations inside the AOI, sim depth from a run, nothing seeded."""
import os

os.environ.setdefault("DRYRUN_STORAGE", "local")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from dryrun import storage  # noqa: E402
from dryrun.api import main, observations  # noqa: E402
from dryrun.contracts import Observation  # noqa: E402

BOUNDS = (3.0, 6.0, 4.0, 7.0)


class _Grid:
    bounds_wgs84 = BOUNDS


class _Aoi:
    grid = _Grid()


def _obs(obs_id, lon, lat, sim=None):
    return Observation(obs_id=obs_id, lon=lon, lat=lat, source="citizen_photo", est_depth_m=0.3,
                       water_fraction=0.4, mask_png=f"/api/observations/{obs_id}/mask.png", sim_depth_m=sim)


@pytest.fixture
def stored(monkeypatch):
    files = {
        "observations/ob_000000000001/observation.json": _obs("ob_000000000001", 3.5, 6.5, sim=0.9).model_dump_json(),
        "observations/ob_000000000001/photo.jpg": "not json",
        "observations/ob_000000000002/observation.json": _obs("ob_000000000002", 5.0, 6.5).model_dump_json(),
        "observations/ob_000000000003/observation.json": "{broken",
        "observations/ob_000000000004/observation.json": _obs("ob_000000000004", 4.0, 7.0).model_dump_json(),
    }
    monkeypatch.setattr(observations, "_CACHE", (0.0, []))
    monkeypatch.setattr(storage, "list_rel", lambda kind, prefix: sorted(files) if kind == "uploads" else [])
    monkeypatch.setattr(storage, "read_upload", lambda rel: files[rel].encode())
    monkeypatch.setattr(storage, "load_aoi", lambda aoi_id: _Aoi() if aoi_id == "test-aoi" else (_ for _ in ()).throw(
        FileNotFoundError(aoi_id)))
    return files


def test_lists_only_inside_and_skips_bad_records(stored):
    r = TestClient(main.app).get("/api/aoi/test-aoi/observations")
    assert r.status_code == 200 and r.headers["cache-control"] == "public, max-age=30"
    body = r.json()
    assert body["aoi_id"] == "test-aoi"
    assert [o["obs_id"] for o in body["observations"]] == ["ob_000000000001", "ob_000000000004"]
    assert body["observations"][0]["sim_depth_m"] == 0.9  # stored value kept without run_id
    assert all("photo.jpg" not in str(o) for o in body["observations"])


def test_run_id_fills_sim_depth(stored, monkeypatch):
    from dryrun.meta import observe
    monkeypatch.setattr(observe, "_sim_depth", lambda run_id, lon, lat: round(lon + lat, 3))
    obs = TestClient(main.app).get("/api/aoi/test-aoi/observations?run_id=r_0123456789abcdef").json()["observations"]
    assert [o["sim_depth_m"] for o in obs] == [10.0, 11.0]


def test_bad_inputs(stored):
    c = TestClient(main.app)
    assert c.get("/api/aoi/test-aoi/observations?run_id=nope").status_code == 400
    assert c.get("/api/aoi/missing-aoi/observations").status_code == 404


def test_empty_when_nothing_uploaded(monkeypatch):
    monkeypatch.setattr(observations, "_CACHE", (0.0, []))
    monkeypatch.setattr(storage, "list_rel", lambda kind, prefix: [])
    monkeypatch.setattr(storage, "load_aoi", lambda aoi_id: _Aoi())
    assert TestClient(main.app).get("/api/aoi/test-aoi/observations").json()["observations"] == []


def test_listing_is_cached(stored, monkeypatch):
    calls = []
    real = storage.list_rel
    monkeypatch.setattr(storage, "list_rel", lambda kind, prefix: calls.append(1) or real(kind, prefix))
    observations.list_for_aoi("test-aoi")
    observations.list_for_aoi("test-aoi")
    assert len(calls) == 1
