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
    g = storage.load_aoi(fixtures.AOI_ID).grid
    assert e["grid_cells"] == g.nx * g.ny and 0 < e["domain_cells"] <= e["grid_cells"]
    assert e["drainage"] is None  # the fixture AOI has no drain network: constant sink
    evs = events(client.post("/api/simulate/stream", json=spec(41)).text)
    kinds = [ev["kind"] for ev in evs]
    assert kinds[0] == "started" and kinds[-1] == "done" and "progress" in kinds
    assert evs[0]["data"]["run_id"] == e["run_id"] and evs[0]["data"]["job_id"]
    s0 = evs[0]["data"]
    assert s0["output_interval_s"] == e["output_interval_s"] > 0
    assert s0["frames_total"] == s0["t_end_s"] // s0["output_interval_s"] + 1
    assert s0["frames_total"] == len(evs[-1]["data"]["manifest"]["frames"])  # the count the board shows
    assert evs[-1]["data"]["manifest"]["status"] == "done"
    assert all(ev["data"]["joined"] is False for ev in evs if ev["kind"] == "progress")  # its own job
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


def test_cancel_by_id_needs_the_token_and_counts_watchers():
    a, _ = jobs.attach("r_cancel", 3600, None, 10)
    b, _ = jobs.attach("r_cancel", 3600, None, 10)
    jobs.watch(a, "w1", "tok1")
    jobs.watch(b, "w2", "tok2")
    assert jobs.cancel("nope", "tok1") is None
    assert jobs.cancel("w1", "tok2") is False and not a.cancelled
    assert jobs.cancel("w1", "tok1") is True and not a.cancelled  # w2 still watching
    jobs.leave("w1")  # the stream's own cleanup after a DELETE: idempotent
    assert not a.cancelled and jobs.watching("w2")
    assert jobs.cancel("w2", "tok2") is True and a.cancelled
    jobs.finish(a)


def test_cancel_route(client):
    assert client.delete("/api/simulate/jobs/nope", headers={"X-Cancel-Token": "x"}).status_code == 404
    job, _ = jobs.attach("r_route", 3600, None, 10)
    jobs.watch(job, "wr", "right")
    assert client.delete("/api/simulate/jobs/wr", headers={"X-Cancel-Token": "wrong"}).status_code == 403
    r = client.delete("/api/simulate/jobs/wr", headers={"X-Cancel-Token": "right"})
    assert r.status_code == 202 and r.json() == {"cancelled": True} and job.cancelled
    jobs.finish(job)


def test_started_carries_a_cancel_token(client):
    evs = events(client.post("/api/simulate/stream", json=spec(43)).text)
    assert len(evs[0]["data"]["cancel_token"]) >= 16


def test_delete_keeps_the_stream_until_the_work_stops(client, monkeypatch):
    """The last viewer's DELETE: progress(phase=cancelling) until the job finishes, then cancelled."""
    import threading

    from dryrun.api import simulate_routes

    monkeypatch.setattr(simulate_routes, "TICK_S", 0.05)
    started = threading.Event()

    def slow_work(job, spec):
        started.set()
        while not job.cancelled:
            job.finished.wait(0.01)
        job.finished.wait(0.3)  # the solver takes a moment to reach its next hook
        jobs.finish(job, error=jobs.Cancelled(job.run_id))

    monkeypatch.setattr(simulate_routes, "_work", slow_work)
    out: list = []

    def reader():
        with client.stream("POST", "/api/simulate/stream", json=spec(47)) as r:
            for line in r.iter_lines():
                if line.startswith("data: "):
                    out.append(json.loads(line[6:]))

    t = threading.Thread(target=reader)
    t.start()
    started.wait(5)
    while not out:
        started.wait(0.01)
    s = out[0]["data"]
    assert client.delete(f"/api/simulate/jobs/{s['job_id']}", headers={"X-Cancel-Token": s["cancel_token"]}).status_code == 202
    t.join(10)
    phases = [e["data"].get("phase") for e in out if e["kind"] == "progress"]
    assert "cancelling" in phases and out[-1]["kind"] == "cancelled"


def test_stale_running_manifest_reads_as_none(client):
    from dryrun.contracts import RunManifest, RunStatus

    s = ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=Storm(total_mm=53, duration_h=1))
    storage.save_run(RunManifest(run_id=s.run_id(), scenario=s, status=RunStatus.running, backend="fake"))
    e = client.post("/api/simulate/estimate", json=spec(53)).json()
    assert e["run_id"] == s.run_id() and e["status"] == "none" and e["cached"] is False


def test_simulate_right_after_stop_gets_a_fresh_job():
    """Eng C's race: Stop, then Simulate on the same spec before the old work has unwound."""
    old, _ = jobs.attach("r_race", 3600, None, 10)
    jobs.watch(old, "w_old", "t_old")
    assert jobs.cancel("w_old", "t_old") is True and old.cancelled and not old.finished.is_set()
    new, created = jobs.attach("r_race", 3600, None, 10)
    assert created and new is not old and not new.cancelled
    token = jobs.bind(old)  # the old engine thread reaching its running save must not move the new job
    try:
        with pytest.raises(jobs.Cancelled):
            jobs.on_save_run("r_race", "running")
    finally:
        jobs.unbind(token)
    assert new.phase == "queued"
    jobs.finish(old, error=jobs.Cancelled("r_race"))
    assert jobs.active("r_race")  # finishing the old job does not drop the new one
    jobs.detach(new)
    jobs.finish(new)


def test_estimate_echoes_resolved_drainage():
    from dryrun.api.simulate_routes import _drainage
    from dryrun.contracts.schemas import Drainage, DrainageDefault

    dflt = DrainageDefault(system="closed", label="Closed sewers", capacity_mm_h=38.1, return_period_yr=3,
                           design_mm_h_by_return_period={"3": 38.1, "10": 54.1}, blockage_pct=10,
                           blockage_range_pct=(0, 50), flap_gates=False, roadside_gutters=False,
                           receiving="East River", storage_mm=10, limits=["test"])
    aoi = storage.load_aoi(fixtures.AOI_ID).model_copy(update={"drainage_default": dflt})
    s = ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=Storm(total_mm=50, duration_h=1),
                     drainage=Drainage(return_period_yr=10, blockage_pct=30))
    assert _drainage(aoi, s) == {"system": "closed", "capacity_mm_h": 54.1, "blockage_pct": 30.0, "outfall": "tide"}
    plain = ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=Storm(total_mm=50, duration_h=1))
    assert _drainage(aoi, plain)["capacity_mm_h"] == 38.1  # nothing set: the AOI default


def test_second_viewer_is_marked_joined(client, monkeypatch):
    """A stream that attaches to a job someone else already started says so (joined=true)."""
    import threading

    from dryrun.api import simulate_routes

    monkeypatch.setattr(simulate_routes, "TICK_S", 0.05)
    release, stop = threading.Event(), threading.Event()

    def held_work(job, s):
        release.wait(5)
        jobs.finish(job, error=jobs.Cancelled(job.run_id))

    monkeypatch.setattr(simulate_routes, "_work", held_work)

    def reader(out, until):
        with client.stream("POST", "/api/simulate/stream", json=spec(49)) as r:
            for line in r.iter_lines():
                if line.startswith("data: "):
                    out.append(json.loads(line[6:]))
                    if until():
                        return

    first: list = []
    t1 = threading.Thread(target=reader, args=(first, stop.is_set))  # stays attached until stop
    t1.start()
    while len(first) < 2:
        release.wait(0.01)
    second: list = []
    t2 = threading.Thread(target=reader, args=(second, lambda: len(second) >= 2))
    t2.start()
    t2.join(5)
    stop.set()
    release.set()
    t1.join(5)
    assert first[1]["data"]["joined"] is False and second[1]["data"]["joined"] is True


@pytest.fixture
def empty_queue(monkeypatch):
    """Earlier tests leave half-built jobs behind; give these an engine with nothing ahead."""
    monkeypatch.setattr(jobs, "_JOBS", {})
    monkeypatch.setattr(jobs, "_OTHER", {})


def _done(*js):
    for j in js:
        jobs.finish(j)


def test_a_queued_job_waits_for_the_solve_ahead(empty_queue, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(jobs.time, "monotonic", lambda: clock[0])
    first, _ = jobs.attach("r_q1", 3600, 30.0, 4)
    jobs.on_save_run("r_q1", "running")  # solving, 10 s in
    clock[0] += 10
    second, _ = jobs.attach("r_q2", 3600, 25.0, 4)
    third, _ = jobs.attach("r_q3", 3600, 20.0, 4)
    try:
        p2, p3 = second.progress(), third.progress()
        assert p2["phase"] == "queued" and p2["ahead"] == 1 and p2["queue_s"] == 20.0
        assert p2["eta_s"] == 45.0  # 20 s left on the solve ahead + its own 25 s
        assert p3["ahead"] == 2 and p3["queue_s"] == 45.0 and p3["eta_s"] == 65.0  # behind both
        assert jobs.queue_ahead() == (65.0, 3)  # what /estimate reports for a new run
        p1 = first.progress()
        assert p1["queue_s"] == 0.0 and p1["ahead"] == 0 and p1["eta_s"] == 20.0  # solving: no queue
    finally:
        _done(first, second, third)
    assert jobs.queue_ahead() == (0.0, 0)


def test_unknown_estimate_ahead_gives_no_number(empty_queue):
    first, _ = jobs.attach("r_u1", 3600, None, 4)
    second, _ = jobs.attach("r_u2", 3600, 25.0, 4)
    try:
        p = second.progress()
        assert p["ahead"] == 1 and p["queue_s"] is None and p["eta_s"] is None  # never a number that is too small
    finally:
        _done(first, second)


def test_a_cancelled_job_is_not_ahead(empty_queue):
    first, _ = jobs.attach("r_c1", 3600, 30.0, 4)
    second, _ = jobs.attach("r_c2", 3600, 25.0, 4)
    jobs.detach(first)  # its only viewer left
    try:
        assert second.progress()["ahead"] == 0
    finally:
        _done(first, second)


def test_solves_without_a_stream_count_too(empty_queue, monkeypatch):
    clock = [5000.0]
    monkeypatch.setattr(jobs.time, "monotonic", lambda: clock[0])
    seen = []
    monkeypatch.setattr(jobs, "_ESTIMATOR", lambda sc: seen.append(sc) or 40.0)
    s = ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=Storm(total_mm=12, duration_h=1))
    jobs.on_save_run("r_agent", "running", s)  # POST /api/simulate or the agent started solving
    clock[0] += 15
    job, _ = jobs.attach("r_after", 3600, 10.0, 4)
    try:
        p = job.progress()
        assert p["ahead"] == 1 and p["queue_s"] == 25.0 and p["eta_s"] == 35.0
        job.progress()
        assert seen == [s]  # estimated once, not every tick
        jobs.on_save_run("r_agent", "done", s)
        assert job.progress()["ahead"] == 0
    finally:
        _done(job)


def test_estimate_and_started_carry_the_queue(empty_queue, client):
    e = client.post("/api/simulate/estimate", json=spec(43)).json()
    assert e["queue_s"] == 0.0 and e["ahead"] == 0
    held, _ = jobs.attach("r_hold", 3600, 50.0, 4)
    try:
        e = client.post("/api/simulate/estimate", json=spec(44)).json()
        assert e["ahead"] == 1 and e["queue_s"] == 50.0
    finally:
        _done(held)
    evs = events(client.post("/api/simulate/stream", json=spec(43)).text)
    assert evs[0]["kind"] == "started" and evs[0]["data"]["queue_s"] == 0.0 and evs[0]["data"]["ahead"] == 0
    assert all("queue_s" in ev["data"] for ev in evs if ev["kind"] == "progress")
