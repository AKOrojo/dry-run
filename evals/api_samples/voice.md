# Voice client protocol

Connect a browser WebSocket to `/api/voice` on the API host.
Use `wss:` when the page uses HTTPS.
Send a JSON text start frame immediately after opening:

```json
{"type":"start","judge_key":"<judge key>","team_token":"<optional team token>"}
```

Provide either credential; omit unused fields.
The server requires start within 10 seconds and checks access before rate limits.
Wait for `{"type":"ready"}` before sending audio.
Capture/resample to raw PCM16, mono, little-endian, 24 kHz.
Send binary frames in real time, ideally 80 ms / 3840 bytes each.
Do not send WAV headers or encoded MediaRecorder chunks.
Frames larger than 64 KiB are rejected.
The relay caps each utterance at 60 seconds of audio.
Client inactivity for 15 seconds ends the session with an error.
To finish, send the JSON text frame `{"type":"stop"}`.
Keep listening after stop; transcription is still running.
Other client text frames are ignored after start.

Server JSON text events:
- `{"type":"partial","text":"..."}` replaces the current cumulative partial.
- `{"type":"final","text":"..."}` is the completed utterance.
- `{"type":"error","error":"..."}` is a displayable failure.

The socket closes after final or error; access/rate errors use close code 1008.
POST final text to `/api/agent` using the normal agent request flow.
The relay does not call the agent. Open a new socket for the next utterance.
