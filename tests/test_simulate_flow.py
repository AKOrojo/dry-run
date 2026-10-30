"""Simulate with an estimate, live progress and cancel (/api/simulate/estimate and /stream, dryrun.jobs)."""
import json
import os

os.environ["DRYRUN_STORAGE"] = "local"
os.environ["DRYRUN_SIM_BACKEND"] = "fake"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from dryrun import jobs, storage  # noqa: E402
from dryrun.api import ratelimit  # noqa: E402
from dryrun.api.main import app  # noqa: E402
from dryrun.api.simulate_routes import _work  # noqa: E402
from dryrun.contracts import ScenarioSpec, Storm  # noqa: E402
from dryrun.pipeline import fixtures  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def aoi(tmp_path_factory):
    root = tmp_path_factory.mktemp("sf")
    storage.LOCAL_DATA, storage.LOCAL_RUNS = root / "data", root / "runs"
    storage.clear_caches()
    fixtures.build()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(ratelimit, "_JUDGE", "")
    return TestClient(app)


def spec(mm: float) -> dict:
    return {"aoi_id": fixtures.AOI_ID, "storm": {"total_mm": mm, "duration_h": 1}}


def events(body: str) -> list[dict]:
    return [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]


def test_estimate_then_stream_then_cached(client):
    e = client.post("/api/simulate/estimate", json=spec(41)).json()
    assert e["cached"] is False and e["status"] == "none" and e["t_end_s"] > 0
    evs = events(client.post("/api/simulate/stream", json=spec(41)).text)
    kinds = [ev["kind"] for ev in evs]
    assert kinds[0] == "started" and kinds[-1] == "done" and "progress" in kinds
    assert evs[0]["data"]["run_id"] == e["run_id"] and evs[0]["data"]["job_id"]
    s0 = evs[0]["data"]
    assert s0["output_interval_s"] == e["output_interval_s"] > 0
    assert s0["frames_total"] == s0["t_end_s"] // s0["output_interval_s"] + 1
    assert s0["frames_total"] == len(evs[-1]["data"]["manifest"]["frames"])  # the count the board shows
    assert evs[-1]["data"]["manifest"]["status"] == "done"
    p = [ev["data"] for ev in evs if ev["kind"] == "progress"][-1]
    assert p["fraction"] == 1.0 and p["eta_s"] == 0.0
    e2 = client.post("/api/simulate/estimate", json=spec(41)).json()
    assert e2["cached"] is True and e2["est_s"] == 0.0 and e2["est_basis"] == "cached"
    evs = events(client.post("/api/simulate/stream", json=spec(41)).text)
    assert [ev["kind"] for ev in evs] == ["started", "done"] and evs[0]["data"]["cached"] is True


def test_bad_spec_is_a_400_before_any_stream(client):
    r = client.post("/api/simulate/stream", json={"aoi_id": "nope-v0", "storm": {"total_mm": 10, "duration_h": 1}})
    assert r.status_code == 404 and r.headers["content-type"].startswith("application/json")


def test_tick_is_a_noop_without_a_job():
    jobs.tick(10, 100)  # CLI, tests, warm_cache: nothing bound


def test_last_watcher_leaving_cancels_and_tick_raises():
    job, created = jobs.attach("r_unit", 3600, 30.0, 10)
    again, created2 = jobs.attach("r_unit", 3600, 30.0, 10)
    assert created and not created2 and again is job
    jobs.detach(job)
    assert not job.cancelled  # one watcher left
    jobs.detach(job)
    assert job.cancelled
    token = jobs.bind(job)
    try:
        with pytest.raises(jobs.Cancelled):
            jobs.tick(60, 3600)
    finally:
        jobs.unbind(token)
        jobs.finish(job)


def test_progress_phases():
    job, _ = jobs.attach("r_phase", 3600, 100.0, 4)
    assert job.progress()["phase"] == "queued" and job.progress()["eta_s"] == 100.0
    jobs.on_save_run("r_phase", "running")
    p = job.progress()
    assert p["phase"] == "solving" and p["measured"] is False
    token = jobs.bind(job)
    jobs.tick(1800, 3600)
    jobs.unbind(token)
    p = job.progress()
    assert p["measured"] and p["sim_t_s"] == 1800 and p["fraction"] == pytest.approx(jobs.SOLVE_SHARE / 2, abs=1e-3)
    jobs.on_write("r_phase")
    jobs.on_write("r_phase")
    p = job.progress()
    assert p["phase"] == "saving" and p["fraction"] == pytest.approx(jobs.SOLVE_SHARE + (1 - jobs.SOLVE_SHARE) / 2)
    jobs.detach(job)
    jobs.finish(job)


def test_cancelled_while_queued_never_solves():
    s = ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=Storm(total_mm=77, duration_h=1))
    job, _ = jobs.attach(s.run_id(), 3600, None, 10)
    jobs.detach(job)  # the only viewer left before the solve began
    _work(job, s)
    assert isinstance(job.error, jobs.Cancelled)
    assert not storage.run_exists(s.run_id())  # nothing persisted, so the next request simply runs it


def test_display_name_drops_the_version_only():
    assert storage.display_name("Lekki-Ajah, Lagos (v2)") == "Lekki-Ajah, Lagos"
    assert storage.display_name("Guadalupe River, Hunt to Kerrville (Texas)").endswith("(Texas)")
    assert storage.display_name("Queens, New York (Ida 2021)").endswith("(Ida 2021)")
