"""Agent tool budgets and public endpoint abuse controls."""

import copy
import json
import os

import pytest
from fastapi.testclient import TestClient

os.environ["DRYRUN_STORAGE"] = "local"
os.environ["DRYRUN_SIM_BACKEND"] = "fake"

from dryrun import presets, storage  # noqa: E402
from dryrun.agent import loop  # noqa: E402
from dryrun.api import ratelimit  # noqa: E402
from dryrun.api.main import app  # noqa: E402
from dryrun.contracts import AgentEvent, ScenarioSpec  # noqa: E402
from dryrun.meta.providers import ToolCall, Turn  # noqa: E402
from dryrun.pipeline import fixtures  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def aoi(tmp_path_factory):
    root = tmp_path_factory.mktemp("guardrails")
    storage.LOCAL_DATA, storage.LOCAL_RUNS = root / "data", root / "runs"
    storage.clear_caches()
    fixtures.build()


@pytest.fixture(autouse=True)
def reset_limits(monkeypatch):
    ratelimit._hits.clear()
    ratelimit._day.clear()
    monkeypatch.setattr(ratelimit, "_TEAM", "")
    monkeypatch.setattr(ratelimit, "_JUDGE", "")
    monkeypatch.delenv("DRYRUN_AGENT_PER_HOUR", raising=False)
    monkeypatch.delenv("DRYRUN_AGENT_PER_DAY", raising=False)


class ScriptedProvider:
    name = "fake"
    model = "scripted"

    def __init__(self, calls_per_turn=1, tool="get_aoi_info", stop_after=None):
        self.calls_per_turn = calls_per_turn
        self.tool = tool
        self.stop_after = stop_after
        self.tool_turns = 0
        self.brief_calls = 0
        self.messages = []

    def chat(self, messages, tools=None, response_format=None, max_tokens=4000):
        self.messages.append(copy.deepcopy(messages))
        if "Write the decision brief" in messages[-1]["content"]:
            self.brief_calls += 1
            return Turn(json.dumps({"title": "Brief", "summary": "Existing results", "claims": []}), [], {})
        if self.stop_after is not None and self.tool_turns >= self.stop_after:
            return Turn("Ready", [], {})
        calls = []
        for i in range(self.calls_per_turn):
            n = self.tool_turns * self.calls_per_turn + i
            args = {"aoi_id": fixtures.AOI_ID}
            if self.tool == "run_simulation":
                args["storm"] = {"total_mm": 50 + n, "duration_h": 1}
            calls.append(ToolCall(f"call_{n}", self.tool, json.dumps(args)))
        self.tool_turns += 1
        return Turn(None, calls, {})


def run_provider(monkeypatch, prov):
    monkeypatch.setattr(loop, "get_provider", lambda name: prov)
    events = list(loop.run("question", aoi_id=fixtures.AOI_ID))
    assert events[-1].kind == "done"
    assert any(e.kind == "brief" for e in events)
    assert prov.brief_calls == 1
    return events


def count_dispatch(monkeypatch):
    calls = []
    real = loop.tools.dispatch

    def dispatch(name, args, session):
        calls.append((name, args))
        return real(name, args, session)

    monkeypatch.setattr(loop.tools, "dispatch", dispatch)
    return calls


def assert_tool_messages(prov):
    messages = prov.messages[-1]
    ids = [c["id"] for m in messages if m["role"] == "assistant" for c in m["tool_calls"]]
    replies = [m["tool_call_id"] for m in messages if m["role"] == "tool"]
    assert ids == replies


def test_max_steps(monkeypatch):
    prov = ScriptedProvider()
    events = run_provider(monkeypatch, prov)
    assert prov.tool_turns == loop.MAX_STEPS
    assert len(prov.messages) == loop.MAX_STEPS + 1
    assert sum(e.kind == "tool_result" for e in events) == loop.MAX_STEPS


def test_per_turn_cap(monkeypatch):
    calls = count_dispatch(monkeypatch)
    prov = ScriptedProvider(10, stop_after=1)
    events = run_provider(monkeypatch, prov)
    assert len(calls) == loop.MAX_CALLS_PER_TURN
    results = [e.data["result"] for e in events if e.kind == "tool_result"]
    assert len(results) == 10
    assert all("error" not in r for r in results[:6])
    assert all("error" in r for r in results[6:])
    assert sum(e.kind == "tool_call" for e in events) == 10
    assert_tool_messages(prov)


@pytest.mark.parametrize("budget", [24, 8])
def test_session_cap(monkeypatch, budget):
    monkeypatch.setattr(loop, "MAX_TOOL_CALLS", budget)
    calls = count_dispatch(monkeypatch)
    prov = ScriptedProvider(6)
    events = run_provider(monkeypatch, prov)
    assert len(calls) == loop.MAX_TOOL_CALLS
    assert prov.tool_turns == (budget + 5) // 6
    assert any(e.kind == "thought" and "Tool budget reached" in e.data["text"] for e in events)
    results = [e.data["result"] for e in events if e.kind == "tool_result"]
    assert all("Tool budget reached" in r["error"] for r in results[budget:])
    assert_tool_messages(prov)


def test_deadline_mid_turn(monkeypatch):
    now = [0]
    monkeypatch.setattr(loop.time, "time", lambda: now[0])
    monkeypatch.setattr(loop, "SESSION_DEADLINE_S", 10)
    real = loop.tools.dispatch
    calls = []

    def dispatch(name, args, session):
        calls.append(name)
        result = real(name, args, session)
        now[0] = 11
        return result

    monkeypatch.setattr(loop.tools, "dispatch", dispatch)
    prov = ScriptedProvider(6)
    events = run_provider(monkeypatch, prov)
    assert len(calls) == 1
    results = [e.data["result"] for e in events if e.kind == "tool_result"]
    assert len(results) == 6
    assert all("Time budget reached" in r["error"] for r in results[1:])
    assert any(e.kind == "thought" and "Time budget reached" in e.data["text"] for e in events)
    assert prov.tool_turns == 1
    assert_tool_messages(prov)


def test_run_budget(monkeypatch):
    n = loop.tools.MAX_RUNS_PER_SESSION
    prov = ScriptedProvider(tool="run_simulation", stop_after=n + 1)
    events = run_provider(monkeypatch, prov)
    results = [e.data["result"] for e in events if e.kind == "tool_result"]
    assert len(results) == n + 1
    assert all(r["status"] == "done" for r in results[:n])
    assert "run budget" in results[n]["error"]


def test_provider_exception(monkeypatch):
    class BrokenProvider(ScriptedProvider):
        def chat(self, messages, tools=None, response_format=None, max_tokens=4000):
            raise RuntimeError("provider unavailable")

    monkeypatch.setattr(loop, "get_provider", lambda name: BrokenProvider())
    events = list(loop.run("question"))
    assert [e.kind for e in events] == ["error", "done"]
    assert events[0].data["stage"] == "chat"


@pytest.fixture
def client(monkeypatch):
    def run(*args, **kwargs):
        yield AgentEvent(kind="done", data={})

    monkeypatch.setattr(loop, "run", run)
    with TestClient(app) as client:
        yield client


def post(client, headers=None, provider="fake"):
    response = client.post("/api/agent", json={"question": "q", "provider": provider}, headers=headers)
    if response.status_code == 200:
        assert '"kind":"done"' in response.text
    return response.status_code


def test_api_default_rate_limit(client):
    assert [post(client) for _ in range(12)] == [200] * 12
    assert post(client) == 429


def test_api_forwarded_prefix_shares_bucket(client):
    first = {"X-Forwarded-For": "9.9.9.9, 1.1.1.1"}
    second = {"X-Forwarded-For": "8.8.8.8, 1.1.1.1"}
    assert [post(client, first) for _ in range(12)] == [200] * 12
    assert post(client, second) == 429


def test_api_team_token(client, monkeypatch):
    monkeypatch.setattr(ratelimit, "_TEAM", "secret")
    assert [post(client, {"X-Team-Token": "secret"}) for _ in range(14)] == [200] * 14
    # A wrong team token is a wrong key: the free path still answers, until 5 wrong keys lock this IP (authguard).
    assert [post(client, {"X-Team-Token": "wrong"}) for _ in range(5)] == [200] * 5
    assert post(client, {"X-Team-Token": "wrong"}) == 429
    assert post(client, {"X-Team-Token": "secret"}) == 429  # locked: even the right key is refused


def test_api_empty_token_does_not_bypass(client):
    assert [post(client, {"X-Team-Token": ""}) for _ in range(12)] == [200] * 12
    assert post(client, {"X-Team-Token": ""}) == 429


def test_api_rejects_provider(client):
    assert post(client, provider="evil") == 400


@pytest.mark.parametrize("question", ["", "   \n\t"])
@pytest.mark.parametrize("provider", ["fake", "meta"])
def test_api_rejects_blank_question(client, monkeypatch, question, provider):
    monkeypatch.setattr(ratelimit, "_TEAM", "secret")
    monkeypatch.setattr(loop, "run", lambda *a, **k: pytest.fail("the planner ran"))
    r = client.post("/api/agent", json={"question": question, "provider": provider}, headers={"X-Team-Token": "secret"})
    assert r.status_code == 422


def test_api_strips_question_before_length_check(client):
    r = client.post("/api/agent", json={"question": "  " + "q" * 1000 + "\n", "provider": "fake"})
    assert r.status_code == 200
    assert client.post("/api/agent", json={"question": "q" * 1001, "provider": "fake"}).status_code == 422


def sim_args(label, total_mm=40):
    return json.dumps({"aoi_id": fixtures.AOI_ID, "storm": {"total_mm": total_mm, "duration_h": 1}, "label": label})


@pytest.mark.parametrize("label", ["baseline 80mm/3h", "drain +40% area-wide", "drains ×3 (Lekki Phase 1)"])
def test_label_accepts_engineering_labels(label):
    assert tools_dispatch("run_simulation", sim_args(label))["status"] == "done"


@pytest.mark.parametrize("label", ["see https://evil.example", "<img src=x onerror=alert(1)>", "x" * 61])
def test_contract_label_rejects_schemes_markup_and_long_text(label):
    # Persisted to the public runs bucket. Bare domains still pass; nothing renders labels as HTML.
    with pytest.raises(ValueError):
        ScenarioSpec(aoi_id=fixtures.AOI_ID, storm={"total_mm": 40, "duration_h": 1}, label=label)


@pytest.mark.parametrize(("total_mm", "label", "stored"), [
    (301, "Baseline: 120 mm", "Baseline 120 mm"),
    (302, "Drains & ponds — Ajah", "Drains ponds Ajah"),
    (303, "<b>x</b> https://evil.example", "b x /b https //evil.example"),
    (304, "y" * 80, "y" * 60),
    (305, ":::", None),
])
def test_agent_labels_are_tidied_not_rejected(total_mm, label, stored):
    # label is not part of run_id, so a distinct storm per case avoids a cache hit carrying another label
    run_id = tools_dispatch("run_simulation", sim_args(label, total_mm))["run_id"]
    assert storage.load_run(run_id).scenario.label == stored


def test_api_simulate_rejects_bad_label(client):
    spec = {"aoi_id": fixtures.AOI_ID, "storm": {"total_mm": 40, "duration_h": 1}, "label": "visit https://x.io"}
    assert client.post("/api/simulate", json=spec).status_code == 422


def tools_dispatch(name, args):
    return loop.tools.dispatch(name, args, loop.tools.Session())


@pytest.mark.parametrize(("provider", "headers", "status"), [
    ("fake", None, 200),
    ("meta", None, 403),
    ("baseten", None, 403),
    ("meta", {"X-Judge-Key": "wrong"}, 403),
    ("meta", {"X-Judge-Key": "judge"}, 200),
    ("baseten", {"X-Judge-Key": "judge"}, 200),
    ("openrouter", None, 403),
    ("openrouter", {"X-Judge-Key": "judge"}, 200),
    ("modal", None, 403),
    ("modal", {"X-Judge-Key": "wrong"}, 403),
    ("modal", {"X-Judge-Key": "judge"}, 200),
    ("modal", {"X-Team-Token": "team"}, 200),
    ("meta", {"X-Team-Token": "team"}, 200),
    ("meta", {"X-Judge-Key": "team"}, 403),
])
def test_paid_providers_need_a_judge_key(client, monkeypatch, provider, headers, status):
    monkeypatch.setattr(ratelimit, "_JUDGE", "judge")
    monkeypatch.setattr(ratelimit, "_TEAM", "team")
    assert post(client, headers, provider) == status


def test_modal_is_reached_only_with_a_judge_key_or_the_team_token(client, monkeypatch):
    """Replay, Fake and visitors never start a session on the Modal provider; a judge or the team does."""
    from dryrun.agent import replay

    made = []

    def run(question, provider_name="meta", aoi_id=None):
        made.append(provider_name)
        yield AgentEvent(kind="done", data={})

    monkeypatch.setattr(loop, "run", run)
    monkeypatch.setattr(ratelimit, "_JUDGE", "judge")
    monkeypatch.setattr(ratelimit, "_TEAM", "team")
    monkeypatch.setattr(replay, "recordings", lambda: [REC])
    monkeypatch.setattr(replay.time, "sleep", lambda s: None)
    monkeypatch.setenv("DRYRUN_AGENT_PER_HOUR", "100")
    assert client.post("/api/agent", json={"question": "replay me", "provider": "replay"}).status_code == 200
    assert post(client, None, "fake") == 200
    assert post(client, None, "modal") == 403
    assert post(client, {"X-Judge-Key": "wrong"}, "modal") == 403
    assert post(client, {"X-Judge-Key": "team"}, "modal") == 403
    assert made == ["fake"]
    assert post(client, {"X-Judge-Key": "judge"}, "modal") == 200
    assert post(client, {"X-Team-Token": "team"}, "modal") == 200
    assert made == ["fake", "modal", "modal"]


def test_modal_provider_sends_the_proxy_token_not_a_bearer_key(monkeypatch):
    import httpx

    from dryrun.meta import providers

    monkeypatch.setitem(providers.DEFAULTS["modal"], "base_url", "https://example.modal.run/v1")
    monkeypatch.setenv("MODAL_PROXY_TOKEN_ID", "wk-test")
    monkeypatch.setenv("MODAL_PROXY_TOKEN_SECRET", "ws-test")
    sent = {}

    class R:
        status_code = 200
        text = ""

        def raise_for_status(self):
            pass

        def json(self):
            return {"id": "x", "choices": [{"message": {"content": "ok"}}]}

    def fake_post(url, json, timeout, headers, follow_redirects=False):
        sent.update(url=url, timeout=timeout, headers=headers, follow=follow_redirects)
        return R()

    monkeypatch.setattr(httpx, "post", fake_post)
    p = providers.get_provider("modal")
    assert p.chat([{"role": "user", "content": "hi"}]).content == "ok"
    assert sent["url"] == "https://example.modal.run/v1/chat/completions"
    assert sent["headers"] == {"Modal-Key": "wk-test", "Modal-Secret": "ws-test"}
    assert sent["timeout"] > 60 and p.wakes and sent["follow"]  # Modal's 303 for a request past 150 s is followed


def test_modal_without_its_url_or_secret_is_not_configured(monkeypatch):
    from dryrun.meta import providers

    monkeypatch.setitem(providers.DEFAULTS["modal"], "base_url", "")
    monkeypatch.setenv("MODAL_PROXY_TOKEN_ID", "wk-test")
    monkeypatch.setenv("MODAL_PROXY_TOKEN_SECRET", "ws-test")
    events = list(loop.run("question", provider_name="modal"))
    assert [e.kind for e in events] == ["error", "done"] and events[0].data["code"] == "llm_not_configured"


def test_unset_judge_key_opens_nothing(client):
    # _JUDGE "" is what "unset" maps to: an empty header must not match it
    assert post(client, {"X-Judge-Key": ""}, "meta") == 403


def test_daily_cap_counts_paid_calls_only(client, monkeypatch):
    monkeypatch.setattr(ratelimit, "_JUDGE", "judge")
    monkeypatch.setenv("DRYRUN_AGENT_PER_DAY", "2")
    monkeypatch.setenv("DRYRUN_AGENT_PER_HOUR", "100")
    assert [post(client) for _ in range(5)] == [200] * 5
    key = {"X-Judge-Key": "judge"}
    assert [post(client, key, "meta") for _ in range(3)] == [200, 200, 429]


def test_missing_provider_key_is_an_error_event(monkeypatch):
    monkeypatch.delenv("META_API_KEY", raising=False)
    events = list(loop.run("question", provider_name="meta"))
    assert [e.kind for e in events] == ["error", "done"]
    assert events[0].data["stage"] == "provider" and events[0].data["code"] == "llm_not_configured"


def test_cache_hits_do_not_spend_run_budget():
    session = loop.tools.Session()
    args = sim_args("cached twice", total_mm=410)
    first = loop.tools.dispatch("run_simulation", args, session)
    for _ in range(loop.tools.MAX_RUNS_PER_SESSION + 2):
        assert loop.tools.dispatch("run_simulation", args, session)["run_id"] == first["run_id"]
    assert session.runs == 1


def test_parse_brief_reports_the_brief_error_not_json_noise():
    class P:
        name, model = "nope", "m"
    text = '{"title": "t", "summary": "s", "claims": [{"text": "x", "unit": "u", "source_run_id": "r", "field": "f"}]}'
    with pytest.raises(ValueError, match="provider"):
        loop._parse_brief(text, P())


@pytest.mark.parametrize("aoi_id, status", [("../etc", 400), ("Bad_ID", 400), ("no-such-aoi", 404)])
def test_agent_rejects_bad_aoi_before_any_call(client, aoi_id, status):
    r = client.post("/api/agent", json={"question": "q", "provider": "fake", "aoi_id": aoi_id})
    assert r.status_code == status


def test_agent_passes_aoi_through(monkeypatch):
    seen = []

    def run(question, provider_name, aoi_id=None):
        seen.append(aoi_id)
        yield AgentEvent(kind="done", data={})

    monkeypatch.setattr(loop, "run", run)
    with TestClient(app) as c:
        assert c.post("/api/agent", json={"question": "q", "provider": "fake", "aoi_id": fixtures.AOI_ID}).status_code == 200
        assert c.post("/api/agent", json={"question": "q", "provider": "fake"}).status_code == 200
    assert seen == [fixtures.AOI_ID, None]


def test_aoi_info_exposes_river_inflows_and_presets(monkeypatch):
    from dryrun.agent import tools

    info = tools.aoi_info(fixtures.AOI_ID)
    assert info["has_river_inflows"] is False and info["presets"] == []

    preset = {"label": "p", "aoi_id": fixtures.AOI_ID, "storm": {"total_mm": 1, "duration_h": 1}}
    other = {**preset, "aoi_id": "some-other-aoi"}
    monkeypatch.setattr(presets, "demo", lambda: {"scenarios": [preset, other]})
    info = tools.aoi_info(fixtures.AOI_ID)
    assert info["presets"] == [preset]  # filtered to this AOI, verbatim
    info["presets"][0]["storm"]["total_mm"] = 99
    assert preset["storm"]["total_mm"] == 1  # callers get copies


def test_demo_presets_are_valid_specs():
    rows = presets.demo()["scenarios"]
    assert rows and {s["aoi_id"] for s in rows} >= {"lagos-lekki-v3", "nyc-queens-v1", "texas-guadalupe-v0"}
    for s in rows:
        ScenarioSpec.model_validate(s)  # a preset the agent copies must pass run_simulation's validation


def test_aois_lists_default_and_preset_aois_that_exist(monkeypatch):
    monkeypatch.setenv("DRYRUN_DEFAULT_AOI", fixtures.AOI_ID)
    monkeypatch.setattr(presets, "demo", lambda: {"scenarios": [{"aoi_id": "not-published"}, {"aoi_id": fixtures.AOI_ID}]})
    with TestClient(app) as c:
        rows = c.get("/api/aois").json()
    assert [r["aoi_id"] for r in rows] == [fixtures.AOI_ID] and rows[0]["name"]


@pytest.mark.parametrize("place, ok", [
    ("Heart O’ the Hills Summer Camp for Girls", True),  # real Texas OSM name: curly apostrophe
    ("Lekki Phase 1", True), ("North Estate (synthetic)", True), ("Ikoyi-Obalende", True),
    ("../manifest", False), ("a/b", False), ("<script>", False), ("x" * 81, False)])
def test_verifier_place_names(place, ok):
    from dryrun.agent.verify import _PLACE

    assert bool(_PLACE.match(place)) is ok


REC = {"question": "Replay me", "aoi_id": fixtures.AOI_ID, "provider": "meta", "model": "muse-spark-1.3",
       "recorded_at": "2026-10-29T20:00:00+00:00",
       "events": [{"t": 1.0, "kind": "tool_call", "data": {"name": "get_aoi_info"}},
                  {"t": 60.0, "kind": "brief", "data": {"title": "t", "claims": []}},
                  {"t": 60.5, "kind": "done", "data": {}}]}


def test_replay_is_labelled_and_shortens_waits():
    from dryrun.agent import replay

    slept = []
    evs = list(replay.stream(REC, sleep=slept.append))
    assert evs[0].kind == "thought" and evs[0].data["replay"] and "not a live model call" in evs[0].data["text"]
    assert [e.kind for e in evs[1:]] == ["tool_call", "brief", "done"]
    assert slept == [1.0, replay.MAX_GAP_S, 0.5]


def test_replay_needs_no_judge_key_and_only_serves_recordings(monkeypatch):
    from dryrun.agent import replay

    monkeypatch.setattr(ratelimit, "_JUDGE", "judge")
    monkeypatch.setattr(replay, "recordings", lambda: [REC])
    monkeypatch.setattr(replay.time, "sleep", lambda s: None)
    with TestClient(app) as c:
        ok = c.post("/api/agent", json={"question": "  replay   ME ", "provider": "replay"})
        missing = c.post("/api/agent", json={"question": "something else", "provider": "replay"})
        listed = c.get("/api/replays").json()
    assert ok.status_code == 200 and '"replay":true' in ok.text and '"kind":"done"' in ok.text
    assert missing.status_code == 404
    assert listed == [{k: REC[k] for k in ("question", "aoi_id", "provider", "model", "recorded_at")}]


def test_tool_results_carry_budget(monkeypatch):
    monkeypatch.setattr(loop.tools, "_cached", lambda spec: False)  # earlier tests may have cached these storms
    prov = ScriptedProvider(tool="run_simulation", stop_after=2)
    events = run_provider(monkeypatch, prov)
    budgets = [e.data["budget"] for e in events if e.kind == "tool_result"]
    assert [b["runs_used"] for b in budgets] == [1, 2]
    assert all(b["runs_max"] == loop.tools.MAX_RUNS_PER_SESSION and b["deadline_s"] == loop.SESSION_DEADLINE_S
               and 0 <= b["elapsed_s"] <= b["deadline_s"] for b in budgets)


def test_aoi_info_tide_only_for_coastal(monkeypatch):
    from dryrun.agent import tools

    tide = tools.aoi_info(fixtures.AOI_ID)["tide"]  # the fixture has a lagoon boundary_mask
    assert tide["default_level_m"] == tools.DEFAULT_TIDE_M and tide["preset_levels_m"] == list(tools.TIDE_PRESETS_M)
    m = storage.load_aoi(fixtures.AOI_ID)
    inland = m.model_copy(update={"layers": {k: v for k, v in m.layers.items() if k != "boundary_mask"}})
    monkeypatch.setattr(tools.storage, "load_aoi", lambda aoi_id: inland)
    assert "tide" not in tools.aoi_info(fixtures.AOI_ID)
    river = m.model_copy(update={"layers": {**m.layers, "inflows": "inflows.json"}})
    monkeypatch.setattr(tools.storage, "load_aoi", lambda aoi_id: river)
    assert "tide" not in tools.aoi_info(fixtures.AOI_ID)


def test_system_prompt_offers_localized_rain_without_digits():
    assert "storm.spatial" in loop.SYSTEM and "never imitate a localized storm" in loop.SYSTEM
    assert not any(ch.isdigit() for ch in loop.SYSTEM)


def test_spatial_schema_states_the_contract_limits():
    from dryrun.agent import tools
    from dryrun.contracts import RainCell

    spatial = tools._SCENARIO["properties"]["storm"]["properties"]["spatial"]
    radius = RainCell.model_fields["radius_m"].metadata
    for lim in radius:
        for k in ("ge", "le"):
            if hasattr(lim, k):
                assert f"{k} {getattr(lim, k)}" in spatial["properties"]["radius_m"]["description"]
    assert "$ref" not in json.dumps(tools._SCENARIO)  # still hand-flattened for OpenAI-compatible endpoints


def test_spatial_place_is_canonicalised_and_rain_warnings_reach_the_agent(monkeypatch):
    from dryrun.agent import tools

    monkeypatch.setattr(tools, "rain_warnings", lambda spec: ["rain: checked."])
    args = json.dumps({"aoi_id": fixtures.AOI_ID, "storm": {
        "total_mm": 63, "duration_h": 1, "spatial": {"kind": "cell", "place": "open field (SYNTHETIC)", "radius_m": 3000,
                                                    "center": None, "track": None}}})
    out = tools.dispatch("run_simulation", args, tools.Session())
    m = storage.load_run(out["run_id"])
    assert m.scenario.storm.spatial.place == "Open Field (synthetic)"
    assert out["status"] == "done" and "rain: checked." in out["warning"]


def test_rain_warnings_come_from_the_preview():
    from dryrun.agent import tools
    from dryrun.contracts import ScenarioSpec

    far = ScenarioSpec(aoi_id=fixtures.AOI_ID, storm={"total_mm": 60, "duration_h": 1, "spatial": {
        "kind": "cell", "place": "Open Field (synthetic)", "radius_m": 15000}})
    assert any("outside the model area" in w for w in tools.rain_warnings(far))


def test_unknown_spatial_place_fails_before_spending_budget():
    from dryrun.agent import tools

    session = tools.Session()
    args = json.dumps({"aoi_id": fixtures.AOI_ID, "storm": {
        "total_mm": 64, "duration_h": 1, "spatial": {"kind": "polygon", "place": "Nowhere"}}})
    with pytest.raises(ValueError):
        tools.dispatch("run_simulation", args, session)
    assert session.runs == 0
