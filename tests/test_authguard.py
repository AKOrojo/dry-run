"""Brute-force lockout for the judge key and the team token (dryrun.api.authguard)."""
import logging
import os

os.environ.setdefault("DRYRUN_STORAGE", "local")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from dryrun import storage  # noqa: E402
from dryrun.api import authguard, ratelimit  # noqa: E402
from dryrun.api.main import app  # noqa: E402

KEY_URL = "/api/tiles/google-key"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "LOCAL_DATA", tmp_path)
    monkeypatch.setattr(ratelimit, "_JUDGE", "judge-key-right")
    monkeypatch.setattr(ratelimit, "_TEAM", "team-key-right")
    monkeypatch.setenv("GOOGLE_TILES_KEY", "k-test")
    return TestClient(app)


class Clock:
    def __init__(self, monkeypatch):
        self.t = 1_000_000.0
        monkeypatch.setattr(authguard.time, "time", lambda: self.t)


def get(client, key=None, ip="5.5.5.5", team=None):
    h = {"X-Forwarded-For": ip}
    if key is not None:
        h["X-Judge-Key"] = key
    if team is not None:
        h["X-Team-Token"] = team
    return client.get(KEY_URL, headers=h)


def test_lockout_after_five_and_right_key_refused(client, monkeypatch):
    Clock(monkeypatch)
    assert [get(client, "nope").status_code for _ in range(5)] == [403] * 5
    r = get(client, "judge-key-right")
    assert r.status_code == 429 and r.headers["X-Auth-Lockout"] == "ip"
    assert 890 <= int(r.headers["Retry-After"]) <= 901
    assert "k-test" not in r.text
    assert get(client, "judge-key-right", ip="6.6.6.6").status_code == 200  # other IPs unaffected


def test_lock_expires_and_doubles_on_repeat(client, monkeypatch):
    clock = Clock(monkeypatch)
    for _ in range(5):
        get(client, "nope")
    clock.t += authguard.BASE_LOCK_S + 1
    assert get(client, "judge-key-right").status_code == 200  # reset after the window
    for _ in range(5):
        get(client, "nope")
    r = get(client, "judge-key-right")
    assert r.status_code == 429 and int(r.headers["Retry-After"]) > authguard.BASE_LOCK_S  # 2nd strike: 30 min
    clock.t += 2 * authguard.BASE_LOCK_S + 1
    assert get(client, "judge-key-right").status_code == 200


def test_lock_is_capped_at_a_day(client, monkeypatch):
    clock = Clock(monkeypatch)
    for _ in range(12):  # many strikes in a row
        for _ in range(5):
            get(client, "nope")
        r = get(client, "judge-key-right")
        assert int(r.headers["Retry-After"]) <= authguard.MAX_LOCK_S + 1
        clock.t += int(r.headers["Retry-After"]) + 1


def test_failures_outside_the_window_do_not_add_up(client, monkeypatch):
    clock = Clock(monkeypatch)
    for _ in range(4):
        get(client, "nope")
    clock.t += authguard.WINDOW_S + 1
    for _ in range(4):
        get(client, "nope")
    assert get(client, "judge-key-right").status_code == 200


def test_wrong_team_token_counts_too(client, monkeypatch):
    Clock(monkeypatch)
    for _ in range(5):
        get(client, team="guess")
    assert get(client, team="team-key-right").status_code == 429


def test_no_key_is_never_counted_and_403_bodies_match(client, monkeypatch):
    Clock(monkeypatch)
    no_key = [get(client) for _ in range(10)]
    assert {r.status_code for r in no_key} == {403}
    wrong = get(client, "nope")
    assert wrong.status_code == 403 and wrong.json() == no_key[0].json()
    assert get(client, "judge-key-right").status_code == 200  # 10 key-less requests locked nothing


def test_global_lock_blocks_keys_but_not_the_demo(client, monkeypatch):
    Clock(monkeypatch)
    for i in range(authguard.GLOBAL_MAX_FAILS + 1):  # spread over many IPs, 1 each
        get(client, "nope", ip=f"10.0.{i // 250}.{i % 250}")
    r = get(client, "judge-key-right", ip="7.7.7.7")
    assert r.status_code == 429 and r.headers["X-Auth-Lockout"] == "global"
    assert client.get("/api/config", headers={"X-Forwarded-For": "7.7.7.7"}).status_code == 200


def test_keys_are_never_logged(client, monkeypatch, caplog):
    Clock(monkeypatch)
    with caplog.at_level(logging.DEBUG):
        for _ in range(6):
            get(client, "SECRET-GUESS-xyz")
        get(client, "judge-key-right")
    assert "SECRET-GUESS-xyz" not in caplog.text and "judge-key-right" not in caplog.text
    assert "auth lockout: ip=5.5.5.5" in caplog.text


def test_store_failure_fails_open(client, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("gcs down")

    monkeypatch.setattr(storage, "read_json", boom)
    monkeypatch.setattr(storage, "update_json", boom)
    assert get(client, "nope").status_code == 403
    assert get(client, "judge-key-right").status_code == 200


def test_admin_view(client, monkeypatch):
    Clock(monkeypatch)
    for _ in range(5):
        get(client, "nope")
    assert client.get("/api/admin/auth").status_code == 403
    st = client.get("/api/admin/auth", headers={"X-Team-Token": "team-key-right", "X-Forwarded-For": "8.8.8.8"}).json()
    assert len(st["locked_ips"]) == 1 and st["global_locked"] is False
    assert "5.5.5.5" not in str(st)  # hashed
