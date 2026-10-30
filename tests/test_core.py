"""Core tests that must stay green on main. Eng A adds tests/test_solver.py (see solver.py docstring)."""

import json
import os

import pytest

os.environ["DRYRUN_STORAGE"] = "local"  # never let tests touch real buckets
os.environ["DRYRUN_SIM_BACKEND"] = "fake"  # core tests run on the fake; A's solver has its own tests

from dryrun import storage  # noqa: E402
from dryrun.agent import verify  # noqa: E402
from dryrun.contracts import (  # noqa: E402
    Brief,
    Claim,
    DrainUpgrade,
    GreenInfrastructure,
    RetentionPond,
    ScenarioSpec,
    Storm,
    TideLevel,
)
from dryrun.pipeline import fixtures  # noqa: E402
from dryrun.sim.engine import run_scenario  # noqa: E402

STORM = Storm(total_mm=120, duration_h=3)
POLY = [(3.488, 6.457), (3.500, 6.457), (3.500, 6.446), (3.488, 6.446)]  # inside the fixture AOI


@pytest.fixture(scope="module", autouse=True)
def aoi(tmp_path_factory):
    from dryrun import storage

    root = tmp_path_factory.mktemp("ft")
    storage.LOCAL_DATA, storage.LOCAL_RUNS = root / "data", root / "runs"
    storage.clear_caches()
    fixtures.build()


def spec(*ivs):
    return ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=STORM, interventions=list(ivs))


def test_run_id_ignores_label_and_is_stable():
    a = spec().model_copy(update={"label": "x"})
    assert a.run_id() == spec().run_id()
    assert spec(DrainUpgrade(capacity_factor=2)).run_id() != spec().run_id()


def test_mass_balance_and_frames():
    m = run_scenario(spec())
    assert m.status == "done"
    assert abs(m.stats.mass_balance_error_pct) < 1.0
    assert m.frames[0].t_s == 0 and len(m.frames) == 6 * 6 + 1


@pytest.mark.parametrize("iv", [
    DrainUpgrade(capacity_factor=3),
    GreenInfrastructure(polygon=POLY, infiltration_mm_h=60),
])
def test_interventions_do_not_worsen(iv):
    base, alt = run_scenario(spec()).stats, run_scenario(spec(iv)).stats
    assert alt.stored_volume_end_m3 <= base.stored_volume_end_m3 * 1.001


def test_pond_captures_water_and_never_worsens_impacts():
    # A pond lowers the DEM: it holds MORE water, but stored pond water is not "flooding".
    base, alt = run_scenario(spec()).stats, run_scenario(spec(RetentionPond(polygon=POLY, depth_m=2))).stats
    assert alt.stored_volume_end_m3 >= base.stored_volume_end_m3
    for f in ("buildings_flooded", "people_exposed", "flooded_area_km2"):
        assert getattr(alt, f) <= getattr(base, f), f
    # roads running through the pond are gone: road_km may rise; that is honest, not a bug


def test_new_drains_where_none_mapped():
    base = run_scenario(spec()).stats
    alt = run_scenario(spec(DrainUpgrade(add_mm_h=40, polygon=POLY))).stats
    assert alt.buildings_flooded < base.buildings_flooded


def test_intervention_outside_aoi_is_reported():
    far = [(3.60, 6.60), (3.61, 6.60), (3.61, 6.59)]
    m = run_scenario(spec(GreenInfrastructure(polygon=far)))
    assert m.intervention_cells == [0]


def test_permanent_water_not_counted_with_no_rain():
    m = run_scenario(ScenarioSpec(aoi_id=fixtures.AOI_ID, storm=Storm(total_mm=0, duration_h=1)))
    assert m.stats.buildings_flooded == 0 and m.stats.flooded_area_km2 == 0


def test_agent_tool_accepts_nulls_and_returns_geography():
    import json

    from dryrun.agent import tools

    info = tools.dispatch("get_aoi_info", json.dumps({"aoi_id": fixtures.AOI_ID}))
    assert info["places"] and info["shelters"]
    out = tools.dispatch("run_simulation", json.dumps({
        "aoi_id": fixtures.AOI_ID, "storm": {"total_mm": 50, "duration_h": 1, "pattern": None},
        "interventions": [{"type": "tide", "boundary_level_m": 1.0, "polygon": None}]}))
    assert out["status"] == "done"


def test_high_tide_worsens():
    base, alt = run_scenario(spec()).stats, run_scenario(spec(TideLevel(boundary_level_m=1.5))).stats
    assert alt.boundary_outflow_m3 < base.boundary_outflow_m3


def test_verifier_fails_closed():
    m = run_scenario(spec())
    n = m.stats.buildings_flooded
    mk = lambda **kw: Claim(**{"text": "t", "unit": "b", "source_run_id": m.run_id,  # noqa: E731
                               "field": "buildings_flooded", **kw})
    sourced, right, wrong = mk(), mk(model_value=n), mk(model_value=n + 1)  # ints must match exactly
    ghost, badfield = mk(source_run_id="r_doesnotexist"), mk(field="not_a_stat")
    b, digits = verify.verify_brief(Brief(title="t", summary="one 2", model="m", provider="fake",
                                          claims=[sourced, right, wrong, ghost, badfield]))
    assert [c.verified for c in b.claims] == [True, True, False, False, False]
    assert b.claims[0].value == n and b.claims[3].value is None
    assert digits


def test_verifier_rejects_ids_that_escape_storage():
    """`field` and `source_run_id` are model-authored and three lookups paste them into a storage
    key. Before the id patterns in verify.py, a crafted `route:` field read an arbitrary JSON file
    and the verifier stamped its number verified=True -- the one component whose job is to make
    numbers trustworthy, laundering an attacker's. Prompt injection reaches this: questions come
    from the public demo URL. GCS keeps ".." literal so prod failed closed, but local mode (every
    laptop, `make api`) did not. Keep this red."""
    from dryrun import storage

    m = run_scenario(spec())
    loot = storage.LOCAL_DATA.parent / "loot.json"
    loot.write_text('{"eta_min": 1337.0}')
    # The traversal only resolves through directories that EXIST -- a bogus run id makes the OS
    # raise ENOENT first, which looks like the attack failed when it has not been tried.
    (storage.LOCAL_DATA / "_private" / "routes" / m.run_id).mkdir(parents=True, exist_ok=True)
    # routes/<run>/<route_id>.json is rooted at data/_private, so four levels lands on loot.json.
    escape = "route:" + "../" * 4 + "loot:eta_min"
    mk = lambda **kw: Claim(**{"text": "t", "unit": "b", "source_run_id": m.run_id,  # noqa: E731
                               "field": "buildings_flooded", **kw})
    bad = [mk(field=escape), mk(field="route:../../_uploads/x:eta_min"),
           mk(source_run_id="../../" + m.run_id), mk(field=f"delta:people_exposed:../{m.run_id}"),
           mk(field="__class__")]
    checked = [verify.check(c) for c in bad]
    assert [c.verified for c in checked] == [False] * len(bad)
    assert all(c.value is None for c in checked)  # never surface a value we could not source
    assert verify.check(mk()).verified  # and the ordinary path still works


def test_int_fields_tracks_the_contract():
    """A field that is an int in the contract but missing from INT_FIELDS is compared with 2% float
    tolerance, so the model can be wrong and still verify -- and nothing raises to tell you. The
    hand-written list had already drifted this way (`t_s` missing, `edges_cut` listed but
    unreachable). Eng A freezes the stat set Thursday; this fails if it stops tracking."""
    from dryrun.contracts import AreaStats, RouteResult, RunStats

    declared = {n for m in (RunStats, RouteResult, AreaStats)
                for n, f in m.model_fields.items() if f.annotation is int}
    assert verify.INT_FIELDS == declared and "t_s" in declared


def test_odd_duration_mass_balance():
    m = run_scenario(spec().model_copy(update={"sim_hours": 2.5, "output_interval_min": 60}))
    assert m.frames[-1].t_s == 9000 and abs(m.stats.mass_balance_error_pct) < 1.0


def test_place_resolution_and_area_stats():
    from dryrun.sim.engine import area_stats

    m = run_scenario(spec(GreenInfrastructure(place="North Estate (synthetic)", infiltration_mm_h=60)))
    assert m.intervention_cells[0] > 0
    a = area_stats(m.run_id, "North Estate (synthetic)")
    assert a["buildings_flooded"] <= m.stats.buildings_flooded
    assert m.timeseries and len(m.timeseries.t_s) == len(m.frames)


def test_digits_in_claim_text_fail_and_area_claims_verify():
    m = run_scenario(spec())
    ok = Claim(text="flooded buildings in the estate", unit="b", source_run_id=m.run_id,
               field="area:North Estate (synthetic):buildings_flooded")
    sneaky = ok.model_copy(update={"text": "cut flooding by 95%"})
    b, digits = verify.verify_brief(Brief(title="Plan 2", summary="s", claims=[ok, sneaky], model="m",
                                          provider="fake"))
    assert [c.verified for c in b.claims] == [True, False] and digits


def test_no_effect_and_pond_over_buildings_warn():
    import json

    from dryrun.agent import tools

    no_drains = tools.dispatch("run_simulation", json.dumps({"aoi_id": fixtures.AOI_ID, "storm": {
        "total_mm": 50, "duration_h": 1}, "interventions": [
        {"type": "drain_upgrade", "capacity_factor": 3, "place": "North Estate (synthetic)"}]}))
    assert "changed NO grid cells" in no_drains["warning"]
    pond = tools.dispatch("run_simulation", json.dumps({"aoi_id": fixtures.AOI_ID, "storm": {
        "total_mm": 50, "duration_h": 1}, "interventions": [
        {"type": "pond", "place": "North Estate (synthetic)"}]}))
    assert "displaces people" in pond["warning"] and pond["stats"]["buildings_in_ponds"] > 0


def test_bad_aoi_does_not_spend_budget():
    import json

    from dryrun.agent import tools

    sess = tools.Session()
    with pytest.raises(Exception):
        tools.dispatch("run_simulation", json.dumps({"aoi_id": "nope", "storm": {"total_mm": 5, "duration_h": 1}}),
                       sess)
    assert sess.runs == 0


def test_route_survives_unreachable_shelter_and_ponds_cut_roads():
    import json

    from dryrun import storage
    from dryrun.contracts import RouteRequest
    from dryrun.routing.evac import route

    fc = json.loads(storage.load_aoi_file(fixtures.AOI_ID, "shelters"))
    fc["features"].append({"type": "Feature", "properties": {"name": "far", "row": 0, "col": 0},
                           "geometry": {"type": "Point", "coordinates": [3.0, 6.0]}})
    storage.write_aoi_file(fixtures.AOI_ID, "shelters.geojson", json.dumps(fc).encode())
    m = run_scenario(spec())
    r = route(RouteRequest(run_id=m.run_id, t_s=0, origin=(3.50, 6.445)))
    assert r.reachable and r.destination_name != "far"
    pond = run_scenario(spec(RetentionPond(place="Canal Corridor (synthetic)", depth_m=2)))
    rp = route(RouteRequest(run_id=pond.run_id, t_s=0, origin=(3.50, 6.445)))
    assert rp.edges_removed > r.edges_removed


def test_brief_retry_recovers():
    from dryrun.agent import loop
    from dryrun.meta import providers

    class Flaky(providers.FakeProvider):
        def __init__(self):
            super().__init__()
            self.briefs = 0

        def chat(self, messages, tools=None, response_format=None, max_tokens=4000):
            t = super().chat(messages, tools, response_format, max_tokens)
            if t.content and t.content.startswith("{"):
                self.briefs += 1
                if self.briefs == 1:
                    return providers.Turn("thinking... {not json", [], {})
            return t

    orig = providers.get_provider
    loop.get_provider = lambda name: Flaky()
    try:
        kinds = [e.kind for e in loop.run("q", "fake")]
    finally:
        loop.get_provider = orig
    assert "brief" in kinds and "error" not in kinds


def test_place_names_match_case_and_apostrophe_alike(monkeypatch):
    import json

    from dryrun.agent import tools

    exact = tools.dispatch("run_simulation", json.dumps({"aoi_id": fixtures.AOI_ID, "storm": {
        "total_mm": 50, "duration_h": 1}, "interventions": [{"type": "green", "place": "North Estate (synthetic)"}]}))
    loose = tools.dispatch("run_simulation", json.dumps({"aoi_id": fixtures.AOI_ID, "storm": {
        "total_mm": 50, "duration_h": 1}, "interventions": [{"type": "green", "place": "north estate (SYNTHETIC)"}]}))
    assert loose["run_id"] == exact["run_id"]  # rewritten to the layer's spelling, so presets/cache still hit
    claim = Claim(text="flooded buildings in the estate", unit="b", source_run_id=exact["run_id"],
                  field="area:NORTH ESTATE (synthetic):buildings_flooded")
    assert verify.check(claim).verified

    places = {"features": [{"properties": {"name": "Heart O’ the Hills"}}]}
    real = storage.load_aoi_file
    monkeypatch.setattr(storage, "load_aoi_file", lambda a, layer: json.dumps(places).encode()
                        if layer == "places" else real(a, layer))
    assert tools.canonical_place(fixtures.AOI_ID, "heart o' the hills") == "Heart O’ the Hills"
    assert tools.canonical_place(fixtures.AOI_ID, "Nowhere") == "Nowhere"


def test_derived_maps_from_stored_frames():
    """arrival/duration come from the depth .npy frames, never change run_id, and agree with the timeseries."""
    import io as _io
    import json

    import numpy as np
    from PIL import Image

    from dryrun import derived
    from dryrun.sim import SOLVER_VERSION, exposure

    m = run_scenario(spec())
    before = (m.run_id, SOLVER_VERSION)
    maps = derived.compute(m.run_id)
    arr, dur = maps["arrival"], maps["duration"]
    assert np.array_equal(np.isnan(arr), np.isnan(dur))
    # wet cells at each frame == cells whose arrival is at or before that frame (ignoring later drying)
    for t, area in zip(m.timeseries.t_s, m.timeseries.flooded_area_km2):
        if area > 0:
            assert (arr <= t / 60).sum() > 0
    first = next(t for t, a in zip(m.timeseries.t_s, m.timeseries.flooded_area_km2) if a > 0)
    assert np.nanmin(arr) == first / 60
    assert np.nanmax(dur) <= m.frames[-1].t_s / 60 and np.nanmin(dur) >= 0
    derived.derive(m.run_id)
    for kind in derived.MAPS:
        img = np.array(Image.open(_io.BytesIO(storage.read_run_file(m.run_id, derived.rel(kind, "png")))))
        assert img.shape[:2] == arr.shape and img.shape[2] == 4
        assert ((img[..., 3] > 0) == ~np.isnan(arr)).all()
        leg = json.loads(storage.read_run_file(m.run_id, derived.rel(kind, "json")))
        assert leg["threshold_m"] == exposure.FLOODED_M and len(leg["alphas"]) == len(leg["edges_min"]) + 1
        assert derived.exists(m.run_id, kind)
    assert (run_scenario(spec()).run_id, SOLVER_VERSION) == before


def test_derived_route():
    from fastapi.testclient import TestClient

    from dryrun.api.main import app

    m = run_scenario(spec())
    c = TestClient(app)
    assert c.get(f"/api/runs/{m.run_id}/derived/velocity.png").status_code == 404
    assert c.get(f"/api/runs/{m.run_id}/derived/arrival.gif").status_code == 404
    assert c.get("/api/runs/r_0000000000000000/derived/arrival.png").status_code == 404
    r = c.get(f"/api/runs/{m.run_id}/derived/arrival.png", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].endswith(f"{m.run_id}/derived/arrival.png")
    r = c.get(f"/api/runs/{m.run_id}/derived/duration.json", follow_redirects=False)
    assert r.headers["location"].endswith("derived/duration.json")


def test_velocity_flows_downhill_and_route():
    import io as _io
    import json

    import numpy as np
    from fastapi.testclient import TestClient
    from PIL import Image

    from dryrun import derived
    from dryrun.api.main import app

    # a 0.5 m sheet on a bed falling eastward and northward: flow runs east (u > 0) and north (v > 0)
    ny, nx = 9, 12
    z = (-0.01 * np.arange(nx))[None, :] + (0.01 * np.arange(ny))[:, None]
    h = np.full((ny, nx), 0.5)
    n = np.full((ny, nx), 0.03)
    u, v, wet = derived.velocity_frame(h, z, n, np.zeros((ny, nx), bool), 30.0, 30.0, 3)
    assert wet.all() and (u[:, 1:-1] > 0).all() and (v[1:-1, :] > 0).all()
    manning = 0.5 ** (2 / 3) * np.sqrt(0.01 / 30) / 0.03  # interior block, uniform slope: Manning velocity
    assert abs(u[1, 1] - manning) < 1e-6 and abs(v[1, 1] - manning) < 1e-6
    still = derived.velocity_frame(np.full((ny, nx), 0.5) - z + z.min(), z, n, np.zeros((ny, nx), bool), 30, 30, 3)
    assert np.allclose(still[0], 0) and np.allclose(still[1], 0)  # flat water surface: no flow

    m = run_scenario(spec())
    manifest, frames = derived.velocity(m.run_id)
    assert len(frames) == len(m.frames) == len(manifest["frames"])
    derived.derive_velocity(m.run_id)
    assert derived.exists(m.run_id, "velocity")
    img = np.array(Image.open(_io.BytesIO(storage.read_run_file(m.run_id, derived.velocity_rel(len(frames) - 1)))))
    u, v, wet = frames[-1]
    assert img.shape == (manifest["ny"], manifest["nx"], 4) and ((img[..., 3] > 0) == wet).all()
    s = manifest["scale_m_s"]
    ok = wet & (np.hypot(u, v) < manifest["vmax_m_s"])
    assert np.allclose((img[..., 0][ok].astype(int) - 128) * s, u[ok], atol=s)
    assert json.loads(storage.read_run_file(m.run_id, derived.rel("velocity", "json")))["frames"][0]["t_s"] == 0
    c = TestClient(app)
    r = c.get(f"/api/runs/{m.run_id}/derived/velocity.json", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].endswith("derived/velocity.v1.json")
    r = c.get(f"/api/runs/{m.run_id}/derived/velocity/3", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].endswith("derived/velocity.v1/0003.png")
    assert c.get(f"/api/runs/{m.run_id}/derived/velocity/{len(m.frames)}").status_code == 404


def test_hazard_loads_profile():
    import json

    import numpy as np
    from fastapi.testclient import TestClient

    from dryrun import derived
    from dryrun.api.main import app

    # AIDR 7-3 Table 2 rows
    d = np.array([0.0, 0.2, 0.4, 1.0, 1.5, 3.0, 5.0, 0.3])
    v = np.array([0.0, 1.0, 1.0, 0.5, 0.5, 1.0, 1.0, 2.5])
    assert derived.hazard_class(d, v).tolist() == [0, 1, 2, 3, 4, 5, 6, 5]
    assert derived.drag_coefficient(np.array([10.0, 16.0, 200.0]), np.ones(3)).tolist() == [1.25, 1.3, 2.0]
    prof = derived.velocity_profile(np.array([0.0, 1.0]), np.array([0.0, 1.0]), np.array([0, 600]), 0.03)
    u = np.array(prof["speed_m_s"])
    assert len(prof["z_m"]) == len(u) and prof["z_m"][-1] == 1.0
    assert (np.diff(u) > 0).all() and prof["surface_speed_m_s"] > 1.0 > u[0]
    # depth average of the log law (integrated from z0 to h) equals the depth-averaged speed, up to the z0/h term
    zz = np.linspace(prof["z0_m"], 1.0, 200001)
    ustar = 1.0 * derived.KAPPA / (np.log(1.0 / prof["z0_m"]) - 1)
    assert abs(np.trapezoid(ustar / derived.KAPPA * np.log(zz / prof["z0_m"]), zz) - 1.0) < 5e-3

    m = run_scenario(spec())
    hz, legend, bl = derived.loads(m.run_id)
    assert set(np.unique(hz)) <= set(range(7)) and len(legend["classes"]) == 6
    n = bl["n_loaded"]
    assert all(len(bl[k]) == n for k in ("ids", "t_s", "depth_m", "drag_kN", "hydrostatic_kN", "cd"))
    assert all(x >= derived.exposure.FLOODED_M - 0.01 for x in bl["depth_m"])
    # hydrostatic matches its formula for each loaded building
    for h, b, f in zip(bl["depth_m"], bl["width_m"], bl["hydrostatic_kN"]):
        assert abs(0.5 * 1000 * 9.81 * h * h * b / 1000 - f) <= 0.05 * f + 0.2
    c = TestClient(app)
    for name in ("hazard.png", "hazard.json", "building_loads.json"):
        r = c.get(f"/api/runs/{m.run_id}/derived/{name}", follow_redirects=False)
        assert r.status_code == 302 and r.headers["location"].endswith(derived.rel(*name.split(".")))
    assert c.get(f"/api/runs/{m.run_id}/derived/building_loads.png").status_code == 404
    assert json.loads(storage.read_run_file(m.run_id, derived.rel("hazard", "json")))["classes"][0]["class"] == "H1"
    g = storage.load_aoi(m.scenario.aoi_id).grid
    w, s_, e, n_ = g.bounds_wgs84
    se = derived.series(m.run_id, (w + e) / 2, (s_ + n_) / 2)
    assert len(se["speed_m_s"]) == len(se["hazard"]) == len(se["t_s"])


def test_events_series_boundary():
    import numpy as np

    from dryrun import derived
    from dryrun.sim import exposure

    m = run_scenario(spec())
    ev = derived.events(m.run_id)
    kinds = {e["kind"]: e for e in ev["events"]}
    ts = m.timeseries
    if any(ts.edges_cut):
        first = kinds["first_cut"]
        assert first["t_s"] == ts.t_s[next(i for i, c in enumerate(ts.edges_cut) if c)]
        assert first["count"] == next(c for c in ts.edges_cut if c)  # engine count, not the float16 recount
    peak = kinds["peak_area"]
    assert peak["flooded_area_km2"] == max(ts.flooded_area_km2) and "deepest" not in json.dumps(ev)
    for p in ev["places"]:
        if p["ten_pct_wet_s"] is not None:
            assert p["ten_pct_wet_s"] in ts.t_s
    s = derived.series(m.run_id, *ev["places"][0]["label_point"])
    assert s["t_s"] == ts.t_s and len(s["depth_m"]) == len(ts.t_s)
    assert s["max_depth_m"] == max(s["depth_m"])
    if s["first_flooded_s"] is not None:
        assert s["depth_m"][s["t_s"].index(s["first_flooded_s"])] >= exposure.FLOODED_M
    with pytest.raises(ValueError):
        derived.series(m.run_id, 0.0, 0.0)
    # outline tracing: a lone cell is one closed square; a block on the grid edge is an open line
    one = np.zeros((3, 3), bool)
    one[1, 1] = True
    (ring,) = derived._trace(one)
    assert ring[0] == ring[-1] and len(ring) == 5
    edge = np.zeros((4, 4), bool)
    edge[:, :2] = True
    (line,) = derived._trace(edge)
    assert line[0] != line[-1] and {p[1] for p in line} == {2}
    b = json.loads(derived.boundary_geojson(fixtures.AOI_ID))
    assert b["type"] == "FeatureCollection"


def test_events_series_boundary_routes():
    from fastapi.testclient import TestClient

    from dryrun import derived
    from dryrun.api.main import app

    m = run_scenario(spec())
    c = TestClient(app)
    r = c.get(f"/api/runs/{m.run_id}/derived/events.json", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].endswith(derived.rel("events", "json"))
    assert c.get(f"/api/runs/{m.run_id}/derived/events.png").status_code == 404
    assert all(derived.exists(m.run_id, k) for k in derived.KINDS)
    lon, lat = json.loads(storage.read_run_file(m.run_id, derived.rel("events", "json")))["places"][0]["label_point"]
    r = c.get(f"/api/runs/{m.run_id}/series", params={"lon": lon, "lat": lat})
    assert r.status_code == 200 and len(r.json()["depth_m"]) == len(m.frames)
    assert c.get(f"/api/runs/{m.run_id}/series", params={"lon": 0, "lat": 0}).status_code == 400
    assert c.get(f"/api/runs/{m.run_id}/series", params={"lon": "nan", "lat": lat}).status_code == 400
    r = c.get(f"/api/aoi/{fixtures.AOI_ID}/boundary.geojson")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/geo+json")


def test_warm_start_preloads_the_baseline_series(monkeypatch):
    from dryrun import derived, presets
    from dryrun.api import main

    base = spec()
    monkeypatch.setattr(presets, "demo", lambda: {"scenarios": [json.loads(base.model_dump_json())]})
    derived._stacks.pop(base.run_id(), None)
    storage._DONE_RUNS.pop(base.run_id(), None)
    for p in (storage.LOCAL_RUNS / base.run_id()).glob("**/*"):  # an earlier test may have run it already
        p.unlink() if p.is_file() else None
    main._preload_series(fixtures.AOI_ID)  # not warmed yet: a no-op, not an error
    assert base.run_id() not in derived._stacks
    run_scenario(base)
    main._preload_series(fixtures.AOI_ID)
    assert base.run_id() in derived._stacks


def test_events_pond_roads_are_not_flood_cuts():
    """A planned pond closes its roads from t=0 (engine edges_cut); events must not call that the first flood cut."""
    from dryrun import derived

    m = run_scenario(spec(RetentionPond(polygon=POLY)))
    n0 = m.timeseries.edges_cut[0]
    assert n0 > 0  # the fixture pond crosses roads
    ev = {e["kind"]: e for e in derived.events(m.run_id)["events"]}
    assert ev["pond_closure"]["count"] == n0 and ev["pond_closure"]["t_s"] == 0
    assert ev["pond_closure"]["road_km"] == m.timeseries.road_km_impassable[0]
    if "first_cut" in ev:
        assert ev["first_cut"]["t_s"] > 0
        i = m.timeseries.t_s.index(ev["first_cut"]["t_s"])
        assert ev["first_cut"]["count"] == m.timeseries.edges_cut[i] - n0
    for p in derived.events(m.run_id)["places"]:
        assert p["first_road_cut_s"] != 0
