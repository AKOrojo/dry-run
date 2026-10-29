"""Offline voice relay protocol and access controls."""

import asyncio
import json
import os
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

os.environ["DRYRUN_STORAGE"] = "local"
os.environ["DRYRUN_SIM_BACKEND"] = "fake"

from dryrun import storage  # noqa: E402
from dryrun.api import ratelimit  # noqa: E402
from dryrun.api.main import app  # noqa: E402
from dryrun.meta import media  # noqa: E402


class FakeUpstream:
    def __init__(self):
        self.frames = []
        self.queue = asyncio.Queue()
        self.reject = False
        self.closed = False
        self.messages = [
            {"type": "transcript", "transcript": "Lek", "final": False},
            {"type": "transcript", "transcript": "Lekki", "final": False},
            {"type": "transcript", "transcript": "Lekki flood", "final": True},
        ]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self.closed = True

    async def send(self, frame):
        self.frames.append(frame)
        if isinstance(frame, str):
            message = json.loads(frame)
            if "authorization" in message:
                await self.queue.put(json.dumps(
                    {"message": "private config"} if self.reject else {"sessionId": "s1"}
                ))
            if message.get("type") == "endStream":
                for transcript in self.messages:
                    await self.queue.put(json.dumps(transcript))
                await self.queue.put(None)

    async def recv(self):
        return await self.queue.get()

    def __aiter__(self):
        return self

    async def __anext__(self):
        frame = await self.recv()
        if frame is None:
            raise StopAsyncIteration
        return frame


@pytest.fixture
def setup(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "LOCAL_DATA", tmp_path / "data")
    monkeypatch.setattr(storage, "LOCAL_RUNS", tmp_path / "runs")
    storage.clear_caches()
    ratelimit._hits.clear()
    ratelimit._day.clear()
    monkeypatch.setattr(ratelimit, "_TEAM", "team")
    monkeypatch.setattr(ratelimit, "_JUDGE", "judge")
    monkeypatch.setenv("META_API_KEY", "offline-secret")
    upstream = FakeUpstream()
    connections = []

    def connect():
        connections.append(True)
        return upstream

    monkeypatch.setattr(media, "_connect_upstream", connect)
    with TestClient(app) as client:
        yield client, upstream, connections
    storage.clear_caches()


def start(ws, **credentials):
    ws.send_json({"type": "start", **credentials})


def closed(ws, code=1000):
    with pytest.raises(WebSocketDisconnect) as exc:
        ws.receive_json()
    assert exc.value.code == code


def test_happy_path(setup):
    client, upstream, connections = setup
    with client.websocket_connect("/api/voice") as ws:
        start(ws, team_token="team")
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes(b"\x01\x00" * 1920)
        ws.send_json({"type": "stop"})
        assert ws.receive_json() == {"type": "partial", "text": "Lek"}
        assert ws.receive_json() == {"type": "partial", "text": "Lekki"}
        assert ws.receive_json() == {"type": "final", "text": "Lekki flood"}
        closed(ws)
    assert connections == [True]
    handshake = json.loads(upstream.frames[0])
    assert handshake == {
        "authorization": {"accessToken": "Bearer offline-secret"},
        "audioEncoding": "PCM_24KHZ", "model": media.ASR_MODEL,
        "mode": "PUSH_TO_TALK", "partialMode": "CUMULATIVE",
        "emitAudioProgress": False, "keywords": media.LAGOS_KEYWORDS, "zdrOverride": True,
    }
    assert upstream.frames[1] == b"\x01\x00" * 1920
    assert json.loads(upstream.frames[2]) == {"type": "endStream"}
    assert upstream.closed


@pytest.mark.parametrize("credentials", [{}, {"judge_key": "wrong"}])
def test_access_denied(setup, credentials):
    client, _, connections = setup
    with client.websocket_connect("/api/voice") as ws:
        start(ws, **credentials)
        message = ws.receive_json()
        assert message["type"] == "error" and "judge key" in message["error"]
        closed(ws, 1008)
    assert not connections
    assert not ratelimit._hits and not ratelimit._day


def test_judge_and_ignored_text(setup):
    client, upstream, _ = setup
    with client.websocket_connect("/api/voice") as ws:
        start(ws, judge_key="judge")
        assert ws.receive_json() == {"type": "ready"}
        ws.send_json({"type": "evil"})
        ws.send_json({"type": "start", "judge_key": "evil"})
        ws.send_json({"type": "stop"})
        while ws.receive_json()["type"] != "final":
            pass
        closed(ws)
    assert len(upstream.frames) == 2
    assert json.loads(upstream.frames[-1]) == {"type": "endStream"}


def test_rejected_handshake(setup):
    client, upstream, _ = setup
    upstream.reject = True
    with client.websocket_connect("/api/voice") as ws:
        start(ws, team_token="team")
        assert ws.receive_json() == {"type": "error", "error": "transcription service unavailable"}
        closed(ws)
    assert upstream.closed


def test_audio_cap(setup, monkeypatch):
    client, upstream, _ = setup
    monkeypatch.setattr(media, "MAX_AUDIO_BYTES", 6)
    with client.websocket_connect("/api/voice") as ws:
        start(ws, team_token="team")
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes(b"1234")
        ws.send_bytes(b"5678")
        while ws.receive_json()["type"] != "final":
            pass
        closed(ws)
    assert b"".join(frame for frame in upstream.frames if isinstance(frame, bytes)) == b"123456"
    assert json.loads(upstream.frames[-1]) == {"type": "endStream"}
    assert upstream.closed


@pytest.mark.parametrize("bucket", ["hour", "day"])
def test_rate_limit(setup, bucket):
    client, _, connections = setup
    if bucket == "hour":
        ratelimit._hits[("voice", "testclient")].extend([time.time()] * 20)
    else:
        ratelimit._day["voice"].extend([time.time()] * 200)
    with client.websocket_connect("/api/voice") as ws:
        start(ws, judge_key="judge")
        message = ws.receive_json()
        assert message["type"] == "error"
        assert ("rate limit" if bucket == "hour" else "capacity") in message["error"]
        closed(ws, 1008)
    assert not connections


@pytest.mark.parametrize("key", [None, "", "unset"])
def test_missing_meta_key(setup, monkeypatch, key):
    client, _, connections = setup
    if key is None:
        monkeypatch.delenv("META_API_KEY")
    else:
        monkeypatch.setenv("META_API_KEY", key)
    with client.websocket_connect("/api/voice") as ws:
        start(ws, team_token="team")
        assert ws.receive_json()["type"] == "error"
        closed(ws)
    assert not connections


@pytest.mark.parametrize("frame", ["bad json", '[]', '{"type":"stop"}', '{"type":"start","judge_key":1}'])
def test_invalid_start(setup, frame):
    client, _, connections = setup
    with client.websocket_connect("/api/voice") as ws:
        ws.send_text(frame)
        assert ws.receive_json()["type"] == "error"
        closed(ws, 1008)
    assert not connections


@pytest.mark.parametrize("timeout", ["START_TIMEOUT", "IDLE_TIMEOUT"])
def test_timeouts(setup, monkeypatch, timeout):
    client, upstream, connections = setup
    monkeypatch.setattr(media, timeout, 0.05)
    with client.websocket_connect("/api/voice") as ws:
        if timeout == "IDLE_TIMEOUT":
            start(ws, team_token="team")
            assert ws.receive_json()["type"] == "ready"
        assert ws.receive_json()["type"] == "error"
        closed(ws, 1008)
    assert upstream.closed if connections else not connections


def test_large_frame(setup):
    client, upstream, _ = setup
    with client.websocket_connect("/api/voice") as ws:
        start(ws, team_token="team")
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes(b"a" * (64 * 1024 + 1))
        assert ws.receive_json()["type"] == "error"
        closed(ws, 1008)
    assert len(upstream.frames) == 1 and upstream.closed


def test_connection_failure(setup, monkeypatch):
    client, _, _ = setup

    def fail():
        raise OSError("private config")

    monkeypatch.setattr(media, "_connect_upstream", fail)
    with client.websocket_connect("/api/voice") as ws:
        start(ws, team_token="team")
        assert ws.receive_json() == {"type": "error", "error": "transcription service unavailable"}
        closed(ws)


def test_speech_complete(setup):
    client, upstream, _ = setup
    upstream.messages = [{"type": "speechComplete", "transcript": "Lekki"}]
    with client.websocket_connect("/api/voice") as ws:
        start(ws, team_token="team")
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "stop"})
        assert ws.receive_json() == {"type": "final", "text": "Lekki"}
        closed(ws)



def test_team_token_reaches_the_rate_limiter(setup, monkeypatch):
    # The token arrives in the start frame, not a header: limit() must still see it to apply the team bypass.
    client, _, _ = setup
    seen = []
    monkeypatch.setattr(ratelimit, "limit", lambda req, *a, **k: seen.append(ratelimit._is_team(req)))
    with client.websocket_connect("/api/voice") as ws:
        start(ws, team_token="team")
        assert ws.receive_json()["type"] == "ready"
    assert seen == [True]
