// The mic in the goal box (board 12, Voice): hold or click to talk; click again or pause 1.5 s to stop; Esc cancels.
// The live transcript fills the box so it can be edited before Ask. A refused microphone shows a slashed mic whose
// Tooltip says how to allow it.
import { useEffect, useRef, useState } from "react";
import { Microphone, MicrophoneSlash, Spinner } from "@phosphor-icons/react";
import { startVoice, voiceError, withTranscript } from "../../lib/voice";
import type { VoiceSession, VoiceState } from "../../lib/voice";
import { mmss } from "./Steps";
import { Button } from "../controls/Button";
import { Tooltip } from "../controls/Tooltip";

/** A press held this long is push-to-talk: letting go stops. A shorter one toggles. */
const HOLD_MS = 400;
const BLOCKED = "The microphone is blocked for this site. Allow it from the icon at the left of the address bar, then press the mic again.";
const pill = { height: 32, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 8, borderRadius: 999, whiteSpace: "nowrap" } as const;

export function VoiceButton({ text, onText, onProblem, disabled = false }: {
  text: string; onText: (t: string) => void;
  /** A voice problem in words (null clears it); key: it needs the judge key, so the key field should show. */
  onProblem: (p: { text: string; key: boolean } | null) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [level, setLevel] = useState(0);
  const [secs, setSecs] = useState(0);
  const session = useRef<VoiceSession | null>(null);
  const before = useRef("");  // the box before talking: Esc puts it back
  const pressed = useRef<{ at: number; started: boolean } | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const live = state === "starting" || state === "listening";

  useEffect(() => {
    if (!live) return;
    setSecs(0);
    const id = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [live]);
  // Esc cancels while listening or waiting for the words, and puts the box back as it was.
  useEffect(() => {
    if (!live && state !== "thinking") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      session.current?.cancel(); session.current = null;
      onText(before.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [live, state]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => session.current?.cancel(), []);

  const start = async () => {
    if (session.current || disabled) return;
    onProblem(null);
    before.current = textRef.current;
    const s = await startVoice({
      onState: (st) => {
        setState(st);
        if (st === "idle" || st === "denied") { session.current = null; setLevel(0); }
        if (st === "denied") onProblem({ text: BLOCKED, key: false });  // also said under the box: the pointer is already on the mic
      },
      onText: (said, final) => { onText(withTranscript(before.current, said)); if (final) session.current = null; },
      onLevel: setLevel,
      onError: (m) => onProblem(m.startsWith("The microphone") || m.startsWith("No microphone") ? { text: m, key: false } : voiceError(m)),
    });
    session.current = s;
  };
  const stop = () => session.current?.stop();

  const down = () => { pressed.current = { at: performance.now(), started: state === "idle" || state === "denied" }; if (pressed.current.started) void start(); };
  const up = () => {
    const p = pressed.current;
    pressed.current = null;
    if (p?.started && performance.now() - p.at >= HOLD_MS) stop();  // push-to-talk released
  };
  // Keyboard (Enter/Space) and a click that did not start the session toggle.
  const click = (e: React.MouseEvent) => {
    if (e.detail === 0) { if (session.current) stop(); else void start(); return; }
    if (!pressed.current && session.current && live) stop();
  };
  const handlers = { onPointerDown: down, onPointerUp: up, onPointerCancel: up, onClick: click };

  if (live) {
    const bars = [0.6, 1, 0.75, 0.9, 0.5].map((k) => Math.max(3, Math.min(14, 3 + level * k * 160)));
    return (
      <Button variant="danfo" aria-label={`Stop listening, ${mmss(secs)}`} {...handlers} onClick={(e) => { if (e.detail === 0 || !pressed.current) stop(); }}
        style={{ ...pill, boxShadow: "0 0 0 3px color-mix(in srgb, var(--danfo) 35%, transparent)" }}>
        <Microphone size={16} weight="bold" aria-hidden="true" />
        <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", gap: 2, height: 14 }}>
          {bars.map((h, i) => <span key={i} style={{ width: 3, height: h, borderRadius: 2, background: "currentColor", transition: "height 80ms linear" }} />)}
        </span>
        <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>Listening · {mmss(secs)}</span>
      </Button>
    );
  }
  if (state === "thinking") {
    return (
      <Button variant="raised" disabled aria-label="Writing out what you said" style={{ ...pill, borderRadius: "var(--radius-md)" }}>
        <Spinner size={16} className="dr-spin" aria-hidden="true" />
        <span style={{ fontWeight: 600 }}>Thinking…</span>
      </Button>
    );
  }
  const denied = state === "denied";
  return (
    <Tooltip text={denied ? BLOCKED : "Talk to type the goal: hold or click, pause to stop"}>
      <Button variant="icon" aria-label={denied ? "Microphone blocked" : "Talk to type the goal"} disabled={disabled} {...handlers}
        style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--control-edge)", borderRadius: "var(--radius-md)",
          background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: denied ? "var(--ink-muted)" : "var(--ink)" }}>
        {denied ? <MicrophoneSlash size={16} weight="bold" aria-hidden="true" /> : <Microphone size={16} weight="bold" aria-hidden="true" />}
      </Button>
    </Tooltip>
  );
}
