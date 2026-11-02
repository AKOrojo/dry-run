import { describe, expect, it } from "vitest";
import { FRAME_SAMPLES, Framer, PauseDetector, RATE, resample, SILENCE_STOP_S, SPEECH_RMS, toPcm16, voiceError, voiceUrl, withTranscript } from "./voice";

describe("voice", () => {
  it("resamples to 24 kHz", () => {
    const one = new Float32Array(48000).fill(0.5);
    const out = resample(one, 48000);
    expect(out.length).toBe(RATE);
    expect(out[100]).toBeCloseTo(0.5);
    expect(resample(new Float32Array([0, 1]), 24000)).toEqual(new Float32Array([0, 1]));
  });
  it("writes little-endian PCM16, clipped", () => {
    const v = new DataView(toPcm16(new Float32Array([1, -1, 0, 2])));
    expect([v.getInt16(0, true), v.getInt16(2, true), v.getInt16(4, true), v.getInt16(6, true)]).toEqual([32767, -32768, 0, 32767]);
  });
  it("hands out whole 80 ms frames of 3840 bytes", () => {
    const f = new Framer();
    expect(f.push(new Float32Array(FRAME_SAMPLES - 1))).toHaveLength(0);
    const frames = f.push(new Float32Array(FRAME_SAMPLES + 1));
    expect(frames).toHaveLength(2);
    expect(toPcm16(frames[0]).byteLength).toBe(3840);
  });
  it("stops after a pause only once speech was heard", () => {
    const d = new PauseDetector(), step = 0.08;
    for (let t = 0; t < 3; t += step) expect(d.feed(0, step)).toBe(false);  // silence before speaking never stops
    d.feed(SPEECH_RMS * 2, step);
    let stopped = false, quiet = 0;
    while (!stopped) { stopped = d.feed(0, step); quiet += step; }
    expect(quiet).toBeGreaterThanOrEqual(SILENCE_STOP_S - 1e-9);
    expect(quiet).toBeLessThan(SILENCE_STOP_S + step);
  });
  it("adds the transcript after what was typed", () => {
    expect(withTranscript("In Lekki:", "would a pond help")).toBe("In Lekki: would a pond help");
    expect(withTranscript("", "would a pond help")).toBe("would a pond help");
    expect(withTranscript("typed ", "")).toBe("typed ");
  });
  it("maps relay errors to the board's words", () => {
    expect(voiceError("judge key or team token required").key).toBe(true);
    expect(voiceError("rate limit exceeded").text).toMatch(/Too many voice/);
    expect(voiceError("transcription service unavailable").text).toMatch(/not available/);
  });
  it("uses wss on https and the API host when one is set", () => {
    expect(voiceUrl("", { protocol: "https:", host: "dryrun.app" })).toBe("wss://dryrun.app/api/voice");
    expect(voiceUrl("", { protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/api/voice");
    expect(voiceUrl("https://api.example.run.app", { protocol: "http:", host: "localhost:5173" })).toBe("wss://api.example.run.app/api/voice");
  });
});
