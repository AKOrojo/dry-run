"""GET /api/aoi/{id}/presets: the AOI's demo specs verbatim, so the UI's first Simulate hits the warmed cache."""
import os

os.environ.setdefault("DRYRUN_STORAGE", "local")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from dryrun import presets, storage  # noqa: E402
from dryrun.api.main import app  # noqa: E402
from dryrun.pipeline import fixtures  # noqa: E402


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    root = tmp_path_factory.mktemp("pr")
    storage.LOCAL_DATA, storage.LOCAL_RUNS = root / "data", root / "runs"
    storage.clear_caches()
    fixtures.build()
    return TestClient(app)


def test_verbatim_list(client, monkeypatch):
    demo = {"scenarios": [{"aoi_id": fixtures.AOI_ID, "label": "a", "storm": {"total_mm": 10, "duration_h": 1}},
                          {"aoi_id": "other-v0", "storm": {"total_mm": 5, "duration_h": 1}}]}
    monkeypatch.setattr(presets, "demo", lambda: demo)
    r = client.get(f"/api/aoi/{fixtures.AOI_ID}/presets")
    assert r.status_code == 200 and r.json() == [demo["scenarios"][0]]


def test_unknown_aoi(client):
    assert client.get("/api/aoi/nope-v0/presets").status_code == 404
