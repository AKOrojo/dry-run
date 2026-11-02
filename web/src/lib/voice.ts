// Voice (board 12): speak the agent's goal. The microphone is streamed to the /api/voice relay (Muse ASR) as raw PCM16
// mono 24 kHz in 80 ms frames (evals/api_samples/voice.md); partial transcripts fill the goal box as they arrive and the
// final one replaces them. The relay never calls the agent: the user edits the text and presses Ask.
import { API, getJudgeKey } from "./api";

export const RATE = 24000;
export const FRAME_SAMPLES = RATE * 0.08;  // 80 ms, 3840 bytes as PCM16
export const SILENCE_STOP_S = 1.5;         // a pause this long after speech stops listening
export const MAX_S = 60;                   // the relay caps an utterance at 60 s of audio
/** RMS above this counts as speech (a quiet room sits near 0.003 with noise suppression on). */
export const SPEECH_RMS = 0.015;

/** Linear-interpolation resample of mono float samples (the microphone runs at 44.1 or 48 kHz). */
export function resample(input: Float32Array, inRate: number, outRate = RATE): Float32Array {
  if (inRate === outRate) return input.slice();
  const n = Math.floor((input.length * outRate) / inRate);
  const out = new Float32Array(n);
  const step = inRate / outRate;
  for (let i = 0; i < n; i++) {
    const x = i * step, j = Math.floor(x), f = x - j;
    const a = input[j], b = j + 1 < input.length ? input[j + 1] : a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

/** Float samples in [-1, 1] as little-endian PCM16. */
export function toPcm16(input: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Collects resampled audio and hands out whole 80 ms frames. */
export class Framer {
  private buf = new Float32Array(0);
  push(samples: Float32Array): Float32Array[] {
    const all = new Float32Array(this.buf.length + samples.length);
    all.set(this.buf);
    all.set(samples, this.buf.length);
    const frames: Float32Array[] = [];
    let i = 0;
    for (; i + FRAME_SAMPLES <= all.length; i += FRAME_SAMPLES) frames.push(all.slice(i, i + FRAME_SAMPLES));
    this.buf = all.slice(i);
    return frames;
  }
}

export const rms = (s: Float32Array) => { let t = 0; for (let i = 0; i < s.length; i++) t += s[i] * s[i]; return s.length ? Math.sqrt(t / s.length) : 0; };

/** Stop-on-pause: true once speech was heard and the last SILENCE_STOP_S were quiet. Fed one frame's RMS at a time. */
export class PauseDetector {
  private heard = false;
  private quietS = 0;
  feed(level: number, seconds: number): boolean {
    if (level >= SPEECH_RMS) { this.heard = true; this.quietS = 0; return false; }
    this.quietS += seconds;
    return this.heard && this.quietS >= SILENCE_STOP_S;
  }
}

/** The goal box while speaking: what was typed before, then the transcript. */
export const withTranscript = (before: string, said: string) => (!said ? before : before.trim() ? `${before.trimEnd()} ${said}` : said);

/** The relay's error text in the board's words. "key" errors bring up the judge-key field. */
export function voiceError(message: string): { text: string; key: boolean } {
  const m = message.toLowerCase();
  if (/judge key|team token|paid|forbidden|not allowed|locked/.test(m)) return { text: "Voice needs the judge key. Paste it below, then press the mic again.", key: true };
  if (/rate|too many|limit/.test(m)) return { text: "Too many voice questions this hour. Type the goal instead, or try again later.", key: false };
  if (/timed out/.test(m)) return { text: "Voice stopped: nothing came through for a while. Press the mic to try again.", key: false };
  if (/unavailable/.test(m)) return { text: "Voice is not available right now. Type the goal instead.", key: false };
  return { text: "Voice stopped. Press the mic to try again, or type the goal.", key: false };
}

export const voiceUrl = (api = API, loc: { protocol: string; host: string } = location) => {
  const base = api ? new URL(api, `${loc.protocol}//${loc.host}`) : new URL(`${loc.protocol}//${loc.host}`);
  return `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}/api/voice`;
};

export type VoiceState = "idle" | "starting" | "listening" | "thinking" | "denied";
export type VoiceEvents = {
  onState: (s: VoiceState) => void;
  onText: (text: string, final: boolean) => void;
  onLevel: (level: number) => void;
  onError: (message: string) => void;
};
export type VoiceSession = { stop: () => void; cancel: () => void };

// The worklet only forwards each 128-sample block to the main thread; resampling and framing happen there.
const WORKLET = `registerProcessor("dr-mic", class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
});`;

/** Opens the microphone and the relay. Partial and final transcripts go to onText; the session ends itself on a final,
 *  an error, a pause after speech or the 60 s cap. stop() sends what was said for transcription; cancel() drops it. */
export async function startVoice(ev: VoiceEvents): Promise<VoiceSession | null> {
  ev.onState("starting");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    const name = (e as Error).name;
    if (name === "NotAllowedError" || name === "SecurityError") { ev.onState("denied"); return null; }
    ev.onError(name === "NotFoundError" ? "No microphone was found." : "The microphone could not be opened.");
    ev.onState("idle");
    return null;
  }
  const ctx = new AudioContext();
  const ws = new WebSocket(voiceUrl());
  ws.binaryType = "arraybuffer";
  const framer = new Framer();
  const pause = new PauseDetector();
  let ready = false, ended = false, stopping = false, sentS = 0;
  const queued: ArrayBuffer[] = [];
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let workletUrl = "";

  const release = () => {
    node?.port.close(); node?.disconnect(); source?.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
    if (workletUrl) URL.revokeObjectURL(workletUrl);
  };
  const finish = (state: VoiceState = "idle") => {
    if (ended) return;
    ended = true;
    release();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    ev.onState(state);
  };
  const stop = () => {
    if (ended || stopping) return;
    stopping = true;
    release();  // the microphone is off as soon as the user is done
    if (ready && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "stop" })); ev.onState("thinking"); }
    else finish();
  };
  const cancel = () => finish();

  ws.onopen = () => {
    let team = "";
    try { team = localStorage.getItem("dr_team_token") ?? ""; } catch { /* storage blocked */ }
    const key = getJudgeKey();
    ws.send(JSON.stringify({ type: "start", ...(key ? { judge_key: key } : {}), ...(team ? { team_token: team } : {}) }));
  };
  ws.onmessage = (m) => {
    if (typeof m.data !== "string") return;
    let msg: { type?: string; text?: string; error?: string };
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === "ready") {
      ready = true;
      if (stopping) { ws.send(JSON.stringify({ type: "stop" })); ev.onState("thinking"); return; }
      queued.splice(0).forEach((f) => ws.send(f));
      ev.onState("listening");
    } else if (msg.type === "partial") ev.onText(msg.text ?? "", false);
    else if (msg.type === "final") { ev.onText(msg.text ?? "", true); finish(); }
    else if (msg.type === "error") { ev.onError(msg.error ?? "voice error"); finish(); }
  };
  ws.onerror = () => { if (!ended) { ev.onError("unavailable"); finish(); } };
  ws.onclose = () => { if (!ended) finish(); };

  try {
    workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(workletUrl);
    if (ended) return null;
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "dr-mic");
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (ended || stopping) return;
      for (const f of framer.push(resample(e.data, ctx.sampleRate))) {
        const level = rms(f);
        ev.onLevel(level);
        const pcm = toPcm16(f);
        if (ready) ws.send(pcm); else queued.push(pcm);
        sentS += FRAME_SAMPLES / RATE;
        if (pause.feed(level, FRAME_SAMPLES / RATE) || sentS >= MAX_S) { stop(); return; }
      }
    };
    // A silent output keeps the worklet pulled by the graph (some browsers skip nodes that reach no destination).
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
  } catch {
    ev.onError("The microphone could not be opened.");
    finish();
    return null;
  }
  return { stop, cancel };
}
