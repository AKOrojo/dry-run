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
    assert r.status_code == 302 and r.headers["location"].endswith("derived/events.json")
    assert c.get(f"/api/runs/{m.run_id}/derived/events.png").status_code == 404
    assert all(derived.exists(m.run_id, k) for k in derived.KINDS)
    lon, lat = json.loads(storage.read_run_file(m.run_id, "derived/events.json"))["places"][0]["label_point"]
    r = c.get(f"/api/runs/{m.run_id}/series", params={"lon": lon, "lat": lat})
    assert r.status_code == 200 and len(r.json()["depth_m"]) == len(m.frames)
    assert c.get(f"/api/runs/{m.run_id}/series", params={"lon": 0, "lat": 0}).status_code == 400
    assert c.get(f"/api/runs/{m.run_id}/series", params={"lon": "nan", "lat": lat}).status_code == 400
    r = c.get(f"/api/aoi/{fixtures.AOI_ID}/boundary.geojson")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/geo+json")
