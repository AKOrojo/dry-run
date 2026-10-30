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


def _req(headers):
    from starlette.requests import Request

    return Request({"type": "http", "headers": [(k.encode(), v.encode()) for k, v in headers.items()],
                    "client": ("1.2.3.4", 1)})


@pytest.mark.parametrize(("judge", "team", "headers", "ok"), [
    ("j-key", "t-key", {}, False),
    ("j-key", "t-key", {"x-judge-key": "wrong"}, False),
    ("j-key", "t-key", {"x-judge-key": "j-key"}, True),
    ("j-key", "t-key", {"x-team-token": "t-key"}, True),
    ("j-key", "t-key", {"x-team-token": "j-key"}, False),  # keys are not interchangeable
    ("", "", {"x-judge-key": ""}, False),                  # unset judge key: nothing opens the gate
])
def test_paid_access_gate(monkeypatch, judge, team, headers, ok):
    from fastapi import HTTPException

    from dryrun.api import ratelimit

    monkeypatch.setattr(ratelimit, "_JUDGE", judge)
    monkeypatch.setattr(ratelimit, "_TEAM", team)
    assert ratelimit.paid_access_configured() == bool(judge)
    if ok:
        ratelimit.require_paid_access(_req(headers))
    else:
        with pytest.raises(HTTPException) as e:
            ratelimit.require_paid_access(_req(headers))
        assert e.value.status_code == 403


def test_warm_start_never_raises_and_reports(monkeypatch, tmp_path):
    from dryrun.api import main
    from dryrun.pipeline import fixtures

    monkeypatch.setattr(storage, "LOCAL_DATA", tmp_path / "data")
    storage.clear_caches()
    fixtures.build()
    ok = main.warm_start(fixtures.AOI_ID)
    assert set(ok) >= {"rasters", "roads", "buildings"} and all(isinstance(v, float) for v in ok.values())
    bad = main.warm_start("no-such-aoi")
    assert all(str(v).startswith("failed") for k, v in bad.items() if k != "numba")
    storage.clear_caches()


def test_done_runs_are_cached_and_running_ones_are_not(tmp_path, monkeypatch):
    from dryrun.contracts import RunManifest, ScenarioSpec

    monkeypatch.setattr(storage, "MODE", "local")
    monkeypatch.setattr(storage, "LOCAL_RUNS", tmp_path)
    storage._DONE_RUNS.clear()
    spec = ScenarioSpec(aoi_id="fixture-synthetic", storm={"total_mm": 50, "duration_h": 1})
    storage.save_run(RunManifest(run_id="r_00000000000000aa", scenario=spec, status="running"))
    assert storage.load_run("r_00000000000000aa").status.value == "running"
    assert "r_00000000000000aa" not in storage._DONE_RUNS
    storage.save_run(RunManifest(run_id="r_00000000000000aa", scenario=spec, status="done"))
    storage.load_run("r_00000000000000aa")
    assert "r_00000000000000aa" in storage._DONE_RUNS
    (tmp_path / "r_00000000000000aa" / "manifest.json").unlink()  # served from memory now
    assert storage.load_run("r_00000000000000aa").status.value == "done"
    storage._DONE_RUNS.clear()
