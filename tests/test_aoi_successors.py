"""/api/config.aoi_successors: an old ?aoi= id points at its replacement, but only once that one is published."""
import os

os.environ.setdefault("DRYRUN_STORAGE", "local")

from fastapi.testclient import TestClient  # noqa: E402

from dryrun.api import main  # noqa: E402


def test_only_published_successors(monkeypatch):
    monkeypatch.setattr(main, "AOI_SUCCESSORS", {"old-v1": "new-v2", "old-v0": "missing-v9"})
    monkeypatch.setattr(main, "_SUCC_CACHE", (0.0, {}))
    published = {"new-v2"}

    def load(aoi_id):
        if aoi_id not in published:
            raise FileNotFoundError(aoi_id)
        return object()

    monkeypatch.setattr(main.storage, "load_aoi", load)
    assert TestClient(main.app).get("/api/config").json()["aoi_successors"] == {"old-v1": "new-v2"}
