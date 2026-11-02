"""Client-facing error envelope and safe model-error classification."""

import json
import os

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

os.environ["DRYRUN_STORAGE"] = "local"
os.environ["DRYRUN_SIM_BACKEND"] = "fake"

from dryrun.agent import loop  # noqa: E402
from dryrun.api.errors import classify_llm_error, error_body, http_error_code  # noqa: E402
from dryrun.api.main import app  # noqa: E402

SECRET = "https://api.example/v1?key=sk-SECRET"


def status_error(code: int, headers=None) -> httpx.HTTPStatusError:
    req = httpx.Request("POST", SECRET)
    return httpx.HTTPStatusError(SECRET, request=req, response=httpx.Response(code, headers=headers, request=req))


@pytest.mark.parametrize("exc, stage, code, retryable", [
    (status_error(401), None, "llm_auth", False),
    (status_error(403), None, "llm_auth", False),
    (status_error(429), None, "llm_rate_limited", True),
    (status_error(503), None, "llm_unavailable", True),
    (status_error(400), None, "llm_bad_request", False),
    (httpx.ReadTimeout(SECRET), None, "llm_timeout", True),
    (httpx.ConnectError(SECRET), None, "llm_unavailable", True),
    (RuntimeError("META_API_KEY is not set for provider 'meta'"), "provider", "llm_not_configured", False),
    (ZeroDivisionError(SECRET), None, "llm_error", True),
    (ValueError("missing key 'tool_calls'"), "chat", "llm_error", True),
    (KeyError("choices"), None, "llm_error", True),
])
def test_classify(exc, stage, code, retryable):
    info = classify_llm_error(exc, stage)
    assert (info["code"], info["retryable"]) == (code, retryable)
    assert "SECRET" not in info["message"] and "META_API_KEY" not in info["message"]


def test_retry_after():
    assert classify_llm_error(status_error(429, {"Retry-After": "17"}))["retry_after_s"] == 17
    assert classify_llm_error(status_error(429, {"Retry-After": "soon"}))["retry_after_s"] == 60


def test_http_codes():
    assert http_error_code(404) == ("not_found", False)
    assert http_error_code(429) == ("rate_limited", True)
    assert http_error_code(504) == ("server_error", True)
    assert http_error_code(418) == ("error", False)
    assert error_body(400, ["x"])["error"]["message"] == "The request failed."


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_envelope_keeps_detail(client):
    r = client.get("/api/runs/not-a-run")
    assert r.status_code == 400
    body = r.json()
    assert body["detail"] == "bad run_id" and body["error"]["code"] == "bad_request"


def test_validation_envelope(client):
    r = client.post("/api/agent", json={})
    assert r.status_code == 422
    body = r.json()
    assert isinstance(body["detail"], list) and body["error"]["code"] == "invalid_input"
    assert body["error"]["message"].startswith("invalid request")


def test_429_has_retry_after(client):
    @app.get("/__test_429")
    def _boom():
        raise HTTPException(429, "rate limit: 1/hour for test")

    r = client.get("/__test_429")
    assert r.status_code == 429 and r.headers["retry-after"] == "60"
    assert r.json()["error"] == {"code": "rate_limited", "message": "rate limit: 1/hour for test", "retryable": True}


def test_agent_error_event_is_safe(monkeypatch):
    class Boom:
        def chat(self, *a, **k):
            raise status_error(429)

    monkeypatch.setattr(loop, "get_provider", lambda name: Boom())
    events = list(loop.run("q", "meta", "fixture-synthetic"))
    err = next(e for e in events if e.kind == "error")
    assert err.data["stage"] == "chat" and err.data["code"] == "llm_rate_limited"
    assert "SECRET" not in str(err.data)


FILTERED = {"error": {"code": "content_policy_violation", "type": "invalid_request_error",
                      "message": "The response was filtered due to the prompt triggering our content management policy."}}


def filtered_error() -> httpx.HTTPStatusError:
    req = httpx.Request("POST", SECRET)
    return httpx.HTTPStatusError(SECRET, request=req, response=httpx.Response(400, json=FILTERED, request=req))


def test_content_filter_is_its_own_retryable_code():
    info = classify_llm_error(filtered_error())
    assert info["code"] == "llm_content_filter" and info["retryable"] and "rephrase" in info["message"]
    assert "sk-SECRET" not in json.dumps(info)


def test_provider_retries_a_content_filter_refusal_once(monkeypatch):
    from dryrun.meta import providers

    monkeypatch.setenv("META_API_KEY", "k")
    req = httpx.Request("POST", "https://api.example/v1/chat/completions")
    ok = {"id": "x", "usage": {}, "choices": [{"message": {"content": "hi", "tool_calls": None}}]}
    for script, want in [([400, 200], "hi"), ([400, 400], None)]:
        replies = [httpx.Response(s, json=FILTERED if s == 400 else ok, request=req) for s in script]
        monkeypatch.setattr(httpx, "post", lambda *a, **k: replies.pop(0))
        p = providers.OpenAICompatProvider("meta")
        if want:
            assert p.chat([{"role": "user", "content": "q"}]).content == want
        else:
            with pytest.raises(httpx.HTTPStatusError) as e:
                p.chat([{"role": "user", "content": "q"}])
            assert classify_llm_error(e.value)["code"] == "llm_content_filter"
        assert not replies  # exactly 1 + CONTENT_FILTER_RETRIES calls, never more


def test_rate_limit_retry_after_is_the_real_wait(monkeypatch):
    """Retry-After says when the oldest hit leaves the hour, not a flat 60 s that would still be refused."""
    from starlette.requests import Request as StarletteRequest

    from dryrun.api import ratelimit

    clock = [10_000.0]
    monkeypatch.setattr(ratelimit.time, "time", lambda: clock[0])
    monkeypatch.setattr(ratelimit, "_hits", ratelimit.defaultdict(ratelimit.deque))
    monkeypatch.setattr(ratelimit, "_TEAM", "")
    req = StarletteRequest({"type": "http", "headers": [(b"x-forwarded-for", b"9.9.9.9")], "client": ("9.9.9.9", 1)})
    ratelimit.limit(req, "t", per_hour=2)
    clock[0] += 600
    ratelimit.limit(req, "t", per_hour=2)
    clock[0] += 60
    with pytest.raises(HTTPException) as e:
        ratelimit.limit(req, "t", per_hour=2)
    assert e.value.headers["Retry-After"] == str(3600 - 660 + 1)  # the first hit ages out in 2940 s
