"""Google Map Tiles key: offered in /api/config, but the key itself only goes to judges and the team."""
import os

os.environ.setdefault("DRYRUN_STORAGE", "local")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from dryrun.api import ratelimit  # noqa: E402
from dryrun.api.main import app  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(ratelimit, "_JUDGE", "judge")
    monkeypatch.setattr(ratelimit, "_TEAM", "team")
    return TestClient(app)


def test_not_configured(client, monkeypatch):
    monkeypatch.delenv("GOOGLE_TILES_KEY", raising=False)
    assert client.get("/api/config").json()["google_tiles_available"] is False
    assert client.get("/api/tiles/google-key", headers={"X-Judge-Key": "judge"}).status_code == 404


@pytest.mark.parametrize("value", ["", "unset"])
def test_placeholder_counts_as_unset(client, monkeypatch, value):
    monkeypatch.setenv("GOOGLE_TILES_KEY", value)
    assert client.get("/api/config").json()["google_tiles_available"] is False


@pytest.mark.parametrize("headers,status", [
    ({}, 403), ({"X-Judge-Key": "wrong"}, 403), ({"X-Judge-Key": ""}, 403),
    ({"X-Judge-Key": "judge"}, 200), ({"X-Team-Token": "team"}, 200),
])
def test_key_only_for_judges_and_team(client, monkeypatch, headers, status):
    monkeypatch.setenv("GOOGLE_TILES_KEY", "k-test")
    assert client.get("/api/config").json()["google_tiles_available"] is True
    assert "k-test" not in client.get("/api/config").text  # never in the public config
    r = client.get("/api/tiles/google-key", headers=headers)
    assert r.status_code == status
    if status == 200:
        assert r.json() == {"key": "k-test"} and r.headers["cache-control"] == "no-store"
    else:
        assert "k-test" not in r.text
