"""GET /api/aoi/{id}/point: a waypoint's description without a run."""
import json
import os

os.environ["DRYRUN_STORAGE"] = "local"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from dryrun import storage  # noqa: E402
from dryrun.api.main import app  # noqa: E402
from dryrun.pipeline import fixtures  # noqa: E402

AOI = fixtures.AOI_ID


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    root = tmp_path_factory.mktemp("pt")
    storage.LOCAL_DATA, storage.LOCAL_RUNS = root / "data", root / "runs"
    storage.clear_caches()
    fixtures.build()
    storage.clear_caches()
    return TestClient(app)


def _place_centre():
    gj = json.loads(storage.load_aoi_file(AOI, "places"))
    f = gj["features"][0]
    ring = f["geometry"]["coordinates"][0]
    lon = sum(p[0] for p in ring[:-1]) / (len(ring) - 1)
    lat = sum(p[1] for p in ring[:-1]) / (len(ring) - 1)
    return f["properties"]["name"], lon, lat


def test_point_inside_a_place(client):
    name, lon, lat = _place_centre()
    r = client.get(f"/api/aoi/{AOI}/point", params={"lon": lon, "lat": lat})
    assert r.status_code == 200
    b = r.json()
    assert b["place"] == {"name": name, "inside": True, "distance_m": 0}
    assert isinstance(b["ground_m"], float)
    assert b["building"]["id"] and b["building"]["distance_m"] >= 0
    assert isinstance(b["open_water"], bool) and isinstance(b["permanent_water"], bool)


def test_point_outside_places_names_the_nearest(client):
    w, s, e, n = storage.load_aoi(AOI).grid.bounds_wgs84
    b = client.get(f"/api/aoi/{AOI}/point", params={"lon": w + 1e-5, "lat": s + 1e-5}).json()
    assert b["place"]["inside"] is False and b["place"]["distance_m"] > 0


def test_point_outside_aoi_is_400(client):
    r = client.get(f"/api/aoi/{AOI}/point", params={"lon": 0, "lat": 0})
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_request"


def test_point_unknown_aoi_is_404(client):
    assert client.get("/api/aoi/nope-v0/point", params={"lon": 0, "lat": 0}).status_code == 404


def test_ring_helpers():
    from dryrun.api.point import _inside, _ring_distance_m

    sq = [(0.0, 0.0), (1e-3, 0.0), (1e-3, 1e-3), (0.0, 1e-3)]
    assert _inside(5e-4, 5e-4, sq) and not _inside(2e-3, 5e-4, sq)
    assert abs(_ring_distance_m(2e-3, 5e-4, sq) - 111.32) < 0.5  # 1e-3 deg of longitude at the equator
