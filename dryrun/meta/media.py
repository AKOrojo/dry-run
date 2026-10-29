"""Voice + image features (owner: Eng C).

Voice (Muse Voice Transcribe, streaming ASR over WebSocket):
  browser mic -> wss://<our host>/api/voice  (relay, so the Meta key never reaches the browser)
  client -> server: text start with judge_key/team_token, then PCM16 mono 24 kHz binary frames;
    text {"type":"stop"} finishes the utterance. See evals/api_samples/voice.md.
  server -> client: ready, partial/final with text, or error with error; closes after final/error.
  upstream: authenticated JSON handshake, binary PCM, then our own endStream.
  The client POSTs the final transcript to /api/agent.

Image (Muse Image edits; owner Eng B, Eng C reviews): street photo + "add bioswale and widened drain"
  -> /v1/images/edits -> PNG, ALWAYS watermarked "AI illustration - not engineering design".
"""

import asyncio
import json
import os
from types import SimpleNamespace

# Must match the chosen AOI (default Lekki-Ajah) and the `places` layer names (Eng D).
LAGOS_KEYWORDS = [
    "Lekki", "Lekki Phase 1", "Ajah", "Sangotedo", "Chevron", "Admiralty Way", "Ikota", "Osapa",
    "Agungi", "Jakande", "Ikate", "Lekki-Epe Expressway", "Abraham Adesanya", "Badore", "Ado Road",
    "Lagos Lagoon", "Victoria Island", "Victoria Garden City", "Ojomu", "Lekki Peninsula II", "Chisco",
]

ASR_MODEL = "muse-voice-transcribe-1.0"
ASR_URL = os.getenv("META_ASR_URL", "wss://api.meta.ai/v1/asr/realtime")
MAX_AUDIO_BYTES = 24000 * 2 * 60
START_TIMEOUT = 10
IDLE_TIMEOUT = 15
SESSION_TIMEOUT = 90  # whole relay, including waiting for the final transcript
IMAGE_MODEL = "muse-image-1.0"


def _connect_upstream():
    import websockets

    return websockets.connect(ASR_URL, open_timeout=10)


async def relay_voice(client_ws) -> None:
    from fastapi import HTTPException, WebSocketDisconnect  # lazy: osm.py imports LAGOS_KEYWORDS from here

    from dryrun.api import ratelimit

    tasks = []
    close_code = 1000

    async def error(message):
        await client_ws.send_json({"type": "error", "error": message})

    async def audio_pump(upstream):
        nonlocal close_code
        total = 0
        while True:
            try:
                frame = await asyncio.wait_for(client_ws.receive(), IDLE_TIMEOUT)
            except TimeoutError:
                await error("voice session timed out")
                close_code = 1008
                return
            if frame["type"] == "websocket.disconnect":
                return
            audio = frame.get("bytes")
            if audio is not None:
                if len(audio) > 64 * 1024:
                    await error("audio frame too large")
                    close_code = 1008
                    return
                chunk = audio[:MAX_AUDIO_BYTES - total]
                if chunk:
                    await upstream.send(chunk)
                    total += len(chunk)
                if total >= MAX_AUDIO_BYTES:
                    break
            else:
                try:
                    message = json.loads(frame.get("text", ""))
                except (ValueError, TypeError):
                    continue
                if isinstance(message, dict) and message.get("type") == "stop":
                    break
        await upstream.send(json.dumps({"type": "endStream"}))
        # Keep the receiver alive until the final transcript arrives.
        await asyncio.Future()

    async def transcript_pump(upstream):
        async for frame in upstream:
            message = json.loads(frame)
            kind = message.get("type")
            if kind not in {"transcript", "speechComplete"}:
                continue
            final = kind == "speechComplete" or message.get("final") is True
            text = message.get("transcript")
            if not isinstance(text, str):
                raise ValueError("invalid transcript")
            await client_ws.send_json({"type": "final" if final else "partial", "text": text})
            if final:
                return
        raise ValueError("missing final transcript")

    try:
        try:
            start = json.loads(await asyncio.wait_for(client_ws.receive_text(), START_TIMEOUT))
            if not isinstance(start, dict) or start.get("type") != "start":
                raise ValueError("expected start")
            if any(not isinstance(start.get(key, ""), str) for key in ("judge_key", "team_token")):
                raise ValueError("invalid credentials")
        except TimeoutError:
            await error("voice session timed out")
            close_code = 1008
            return
        except (ValueError, TypeError, KeyError, RuntimeError):
            await error("invalid start frame")
            close_code = 1008
            return
        # Browsers cannot set WebSocket headers: the keys arrive in the start frame. One request-like object
        # carries them plus the real client address, so the team token also bypasses the per-IP limit.
        headers = SimpleNamespace(client=client_ws.client, headers={
            "x-forwarded-for": client_ws.headers.get("x-forwarded-for", ""),
            "x-judge-key": start.get("judge_key", ""),
            "x-team-token": start.get("team_token", ""),
        })
        try:
            ratelimit.require_paid_access(headers)
            ratelimit.limit(headers, "voice", per_hour=20)
            ratelimit.limit_global("voice", per_day=200, request=headers)
        except HTTPException as exc:
            await error(exc.detail)
            close_code = 1008
            return
        try:
            key = os.environ["META_API_KEY"].strip()
        except KeyError:
            key = ""
        if not key or key == "unset":
            await error("transcription service unavailable")
            return
        async with _connect_upstream() as upstream:
            await asyncio.wait_for(upstream.send(json.dumps({
                "authorization": {"accessToken": f"Bearer {key}"},
                "audioEncoding": "PCM_24KHZ", "model": ASR_MODEL,
                "mode": "PUSH_TO_TALK", "partialMode": "CUMULATIVE",
                "emitAudioProgress": False, "keywords": LAGOS_KEYWORDS, "zdrOverride": True,
            })), START_TIMEOUT)
            ack = json.loads(await asyncio.wait_for(upstream.recv(), START_TIMEOUT))
            if not isinstance(ack, dict) or "sessionId" not in ack:
                await error("transcription service unavailable")
                return
            await client_ws.send_json({"type": "ready"})
            tasks = [asyncio.create_task(audio_pump(upstream)), asyncio.create_task(transcript_pump(upstream))]
            try:
                done, _ = await asyncio.wait(tasks, timeout=SESSION_TIMEOUT, return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    await error("voice session timed out")
                    close_code = 1008
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except WebSocketDisconnect:
        pass
    except Exception:
        await error("transcription service unavailable")
    finally:
        try:
            await client_ws.close(code=close_code)
        except (RuntimeError, WebSocketDisconnect):
            pass


def render_intervention(photo: bytes, instruction: str) -> bytes:  # TODO Day 5 (owner: B; C reviews)
    raise NotImplementedError
