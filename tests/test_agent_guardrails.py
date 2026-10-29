"""Agent tool budgets and public endpoint abuse controls."""

import copy
import json
import os

import pytest
from fastapi.testclient import TestClient

os.environ["DRYRUN_STORAGE"] = "local"
os.environ["DRYRUN_SIM_BACKEND"] = "fake"

from dryrun import storage  # noqa: E402
from dryrun.agent import loop  # noqa: E402
from dryrun.api import ratelimit  # noqa: E402
from dryrun.api.main import app  # noqa: E402
from dryrun.contracts import AgentEvent  # noqa: E402
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
    prov = ScriptedProvider(tool="run_simulation", stop_after=7)
    events = run_provider(monkeypatch, prov)
    results = [e.data["result"] for e in events if e.kind == "tool_result"]
    assert len(results) == 7
    assert all(r["status"] == "done" for r in results[:6])
    assert "run budget" in results[6]["error"]


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
    assert [post(client, {"X-Team-Token": "wrong"}) for _ in range(12)] == [200] * 12
    assert post(client, {"X-Team-Token": "wrong"}) == 429


def test_api_empty_token_does_not_bypass(client):
    assert [post(client, {"X-Team-Token": ""}) for _ in range(12)] == [200] * 12
    assert post(client, {"X-Team-Token": ""}) == 429


def test_api_rejects_provider(client):
    assert post(client, provider="evil") == 400
