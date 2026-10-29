"""Storage keys cannot escape their root (issue #3); the team bypass compares in constant time."""

import pytest

from dryrun import storage


@pytest.mark.parametrize("rel", ["../x", "runs/../../x", "a/../b", "/etc/passwd", "a//b", "./a", "a\\..\\b", "", "a\0b"])
def test_bad_keys_are_rejected(rel):
    with pytest.raises(ValueError):
        storage._safe_rel(rel)
    with pytest.raises(ValueError):
        storage._read_bytes("runs", rel)
    with pytest.raises(ValueError):
        storage._write_bytes("runs", rel, b"x", "text/plain")
    with pytest.raises(ValueError):
        storage._exists("data", rel)


def test_good_keys_pass(tmp_path, monkeypatch):
    assert storage._safe_rel("r_0123456789abcdef/frames/f_000.png") == "r_0123456789abcdef/frames/f_000.png"
    assert storage._safe_rel("fixture-synthetic/dem.npy") == "fixture-synthetic/dem.npy"
    assert storage._safe_rel("a..b/c") == "a..b/c"  # dots inside a name are fine


def test_traversal_never_touches_the_filesystem(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "LOCAL_RUNS", tmp_path / "runs")
    with pytest.raises(ValueError):
        storage.write_run_file("..", "escaped.txt", b"x", "text/plain")
    assert not (tmp_path / "escaped.txt").exists()


def test_public_run_url_is_guarded():
    assert storage.public_run_url("r_0123456789abcdef", "frames/f_000.png").endswith("/r_0123456789abcdef/frames/f_000.png")
    with pytest.raises(ValueError):
        storage.public_run_url("..", "x.png")


def test_team_bypass_uses_constant_time_compare(monkeypatch):
    from starlette.requests import Request

    from dryrun.api import ratelimit

    def req(token):
        headers = [(b"x-team-token", token.encode())] if token is not None else []
        return Request({"type": "http", "headers": headers, "client": ("1.2.3.4", 1)})

    monkeypatch.setattr(ratelimit, "_TEAM", "s3cret")
    assert ratelimit._is_team(req("s3cret"))
    assert not ratelimit._is_team(req("s3cre")) and not ratelimit._is_team(req(None))
    monkeypatch.setattr(ratelimit, "_TEAM", "")
    assert not ratelimit._is_team(req(""))
