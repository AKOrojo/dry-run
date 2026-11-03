// Agent panel (rev5 restyle: docs/design/rev5-ref/Agent.dc.html). Four states: Ask, Working, Brief, Replay and failure.
// Unverified claims render greyed with a warning: the fail-closed rule is visible to judges.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ClockCounterClockwise, Copy, Key, PaperPlaneTilt, Columns, Flask, ArrowClockwise, Sparkle, Stop } from "@phosphor-icons/react";
import { ApiError, askAgent, AgentEvent, getJudgeKey, getReplays, QUESTION_MAX, Replay, setJudgeKey } from "../lib/api";
import { lockoutText, useLockout } from "../lib/lockout";
import { LockoutNote } from "./LockoutNote";
import { Notice } from "./Notice";
import { Card, Field, Segmented, FIG, hintText, srOnly } from "./rev5";
import { replayHint } from "../lib/replay";
import { Badge, Btn, Dot, Footer, Pad } from "./agent/bits";
import { BriefCard, ClaimsCard, briefText } from "./agent/Brief";
import { Stepper, briefPhase, buildSteps, lastBudget, mmss } from "./agent/Steps";
import { revealIn } from "../lib/reveal";
import { TextField } from "./controls/TextField";
import { Button } from "./controls/Button";
import { VoiceButton } from "./agent/Voice";

// Server error codes (dryrun/api/errors.py) that the fake agent sidesteps.
const FAKE_HELPS = ["llm_auth", "llm_not_configured", "llm_unavailable"];
type Failure = { code: string; message: string; retryable: boolean; retry_after_s?: number };
type Mode = "live" | "replay" | "fake";

const SUGGESTIONS = ["Which places flood first?", "Compare new drains with green space in Lekki Phase 1", "Is Admiralty Way passable at the peak?"];
const MODEL_NAME: Record<string, string> = { meta: "Muse Spark 1.3", openrouter: "Muse Spark Open", modal: "Muse Glimmer 30B" };
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const CSS = `@keyframes dr-spin{to{transform:rotate(360deg)}}@keyframes dr-indet{0%{margin-left:-40%}100%{margin-left:100%}}
.dr-spin{animation:dr-spin 1s linear infinite}.dr-indet{animation:dr-indet 1.4s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.dr-spin,.dr-indet{animation:none}}`;

const inputBox = { background: "var(--ground)", border: "1px solid var(--control-edge)", borderRadius: "var(--radius-md)",
  boxShadow: "inset 0 1px 2px var(--elev-drop-soft)", color: "var(--ink)", font: "inherit" } as const;

export function AgentPanel({ onRun, onAoi, onReplay, onEvents, briefExtra, defaultProvider, aoiId, judgeKeyRequired = false, glimmerAvailable = false, liveProvider }:
  { onRun: (runId: string) => void; onAoi?: (aoiId: string) => void; onReplay?: (replayed: boolean) => void;
    /** The session's events so far (Agent mode's runs card, dock charts and log read them). */
    onEvents?: (events: AgentEvent[]) => void;
    /** Shown under the brief (the per-run bars for the studied place). */
    briefExtra?: ReactNode;
    defaultProvider: string; aoiId?: string; judgeKeyRequired?: boolean;
    /** The server can reach Muse Glimmer 30B on our Modal app: Live offers it beside the default live model. */ glimmerAvailable?: boolean;
    /** The paid provider Live runs on by default (/api/config.live_provider), when the default provider is Replay or Fake. */
    liveProvider?: string | null }) {
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState(defaultProvider);
  useEffect(() => setProvider(defaultProvider), [defaultProvider]);
  const baseLive = defaultProvider === "fake" || defaultProvider === "replay" ? (liveProvider ?? "meta") : defaultProvider;
  // The live model last picked (the default one, or Muse Glimmer 30B), kept while Replay or Fake is on.
  const [lastLive, setLastLive] = useState(baseLive);
  useEffect(() => setLastLive(baseLive), [baseLive]);
  const liveProv = provider === "fake" || provider === "replay" ? lastLive : provider;
  const mode: Mode = provider === "replay" ? "replay" : provider === "fake" ? "fake" : "live";
  const [events, setEvents] = useState<AgentEvent[]>([]);
  useEffect(() => { onEvents?.(events); }, [events]);
  const [ts, setTs] = useState<number[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const stopRef = useRef(false);
  const [err, setErr] = useState<Failure | null>(null);
  const [wait, setWait] = useState(0);  // seconds left before Retry is allowed (rate limits)
  const [waitTotal, setWaitTotal] = useState(0);
  useEffect(() => { if (wait > 0) { const t = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(t); } }, [wait]);
  useEffect(() => { if (!busy) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [busy]);
  const [key, setKey] = useState(getJudgeKey);
  const [voiceProblem, setVoiceProblem] = useState<{ text: string; key: boolean } | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const lock = useLockout();
  const keyProvider = provider !== "fake" && provider !== "replay";  // Replay and Fake never send a key: never locked
  const needsKey = (judgeKeyRequired || err?.code === "forbidden" || !!lock) && keyProvider;
  useEffect(() => { if (err?.code === "forbidden") keyRef.current?.focus(); }, [err]);
  // Live reveals the key row, often below the fold in a phone sheet: bring it into view (above the Ask bar, which the
  // side panel's scroll-padding accounts for), so its Show key button is not under the footer.
  const keyShown = useRef<boolean | null>(null);
  useEffect(() => {
    const was = keyShown.current;
    keyShown.current = needsKey;
    if (was === false && needsKey) requestAnimationFrame(() => {
      const box = keyRef.current?.parentElement;
      box?.scrollIntoView({ block: "nearest" });
      box?.querySelector("button")?.scrollIntoView({ block: "nearest" });  // its 40 px touch target outgrows the box
    });
  }, [needsKey]);
  useEffect(() => { if (voiceProblem?.key) keyRef.current?.focus(); }, [voiceProblem]);
  const [replays, setReplays] = useState<Replay[]>([]);
  useEffect(() => { getReplays().then(setReplays, () => setReplays([])); }, []);
  const replay = provider === "replay" ? replays.find((r) => r.question === q) : undefined;
  const [copied, setCopied] = useState(false);

  const fail = (f: Failure) => { setErr(f); setWait(f.retry_after_s ?? 0); setWaitTotal(f.retry_after_s ?? 0); };
  const ask = async (prov = provider) => {
    setBusy(true); setEvents([]); setTs([]); setErr(null); setWait(0); stopRef.current = false;
    if (replay && replay.aoi_id !== aoiId) onAoi?.(replay.aoi_id);  // show the recording's own study area
    try {
      for await (const ev of askAgent(q, prov, aoiId)) {
        if (stopRef.current) break;
        setEvents((p) => [...p, ev]); setTs((p) => [...p, Date.now()]);  // an error event keeps the claims and runs already streamed
        if (ev.kind === "run_ready") onRun(ev.data.run_id);
        if (ev.kind === "error") fail(ev.data);
      }
    } catch (e) {
      // A lockout counts down under the key box (minutes to hours), not as a Retry timer.
      if (e instanceof ApiError && e.lockout) fail({ code: "rate_limited", message: e.message, retryable: false });
      // The box already trims and caps the question, so a 422 here means it broke the server's own limits.
      else if (e instanceof ApiError && e.status === 422) fail({ code: e.code, message: `Write a question of up to ${QUESTION_MAX} characters.`, retryable: false });
      else fail(e instanceof ApiError ? { code: e.code, message: e.message, retryable: e.retryable, retry_after_s: e.retryAfterS }
        : { code: "unavailable", message: "The server is busy. Try again.", retryable: true });
    } finally { setBusy(false); }
  };
  const useFake = () => { setProvider("fake"); ask("fake"); };
  const reset = () => { setEvents([]); setTs([]); setErr(null); setWait(0); };
  const brief = events.find((e) => e.kind === "brief")?.data;
  const intro = events.find((e) => e.kind === "thought" && e.data.replay)?.data.text as string | undefined;
  const replayed = !!intro;
  useEffect(() => { onReplay?.(replayed); }, [replayed]);  // eslint-disable-line react-hooks/exhaustive-deps
  const introMatch = intro?.match(/\((.+?) via (.+?), recorded (.+?)\)/);
  const thoughts = events.filter((e) => e.kind === "thought" && !e.data.replay);
  const thought = thoughts.length ? (thoughts[thoughts.length - 1].data.text as string) : undefined;
  const steps = buildSteps(events, ts);
  const budget = lastBudget(events);
  const writing = busy && !err ? briefPhase(events, ts) : undefined;
  // The writing row and the Failure card can land below the fold (a phone sheet at half): bring each into view once
  // when it appears, not on timer ticks.
  const rootRef = useRef<HTMLDivElement>(null);
  const reveal = (sel: string, card = false) => requestAnimationFrame(() => revealIn(rootRef.current, sel, card, reducedMotion()));
  useEffect(() => { if (writing) reveal("[data-agent-writing]"); }, [writing?.t0]);
  useEffect(() => { if (err) reveal("[data-agent-failure]", true); }, [err]);
  const modelName = brief?.model ?? introMatch?.[1] ?? MODEL_NAME[provider] ?? provider;
  const started = events.length > 0 || busy || !!err;

  const keyField = (
    <Field label="Judge key" hint="Kept in this tab only.">
      <TextField ref={keyRef} type="password" autoComplete="off" placeholder="Paste the judge key" aria-label="Judge key" value={key}
        leadingIcon={<Key size={16} weight="bold" aria-hidden="true" style={{ flex: "none", color: "var(--ink-muted)" }} />}
        onChange={(e) => { setKey(e.target.value); setJudgeKey(e.target.value.trim()); }} />
      {lock && <LockoutNote lock={lock} />}
    </Field>
  );
  const nearMax = q.length > QUESTION_MAX * 0.9;  // the counter shows only near the limit
  const offRecord = replayHint(provider, q, replays.map((r) => r.question));
  const canAsk = !busy && q.trim() !== "" && !(needsKey && !key.trim()) && !(keyProvider && lock) && !(provider === "replay" && !replay);
  const copy = () => { if (brief) navigator.clipboard?.writeText(briefText(brief)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {}); };

  const stack = { display: "flex", flexDirection: "column", gap: 12, minHeight: "100%" } as const;

  if (!started) {
    return (
      <div style={stack}>
        <style>{CSS}</style>
        <Card title="Ask the planner" right={<span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-muted)" }}>
          {mode === "live" && <><Dot color="var(--verified)" />{MODEL_NAME[liveProv] ?? liveProv}</>}</span>}>
          <Pad gap={12}>
            <div data-tour="voice" style={{ position: "relative" }}>
              <TextField multiline aria-label="Goal" value={q} onChange={(e) => setQ(e.target.value.slice(0, QUESTION_MAX))} rows={4} placeholder="Describe what you want the planner to find out, or press the mic and say it."
                maxLength={QUESTION_MAX} aria-describedby={nearMax ? "goal-count" : undefined}
                style={{ fontSize: 14, lineHeight: "20px", paddingBottom: 48 }} />
              <div style={{ position: "absolute", right: 8, bottom: 8 }}>
                <VoiceButton text={q} onText={(t) => setQ(t.slice(0, QUESTION_MAX))} onProblem={setVoiceProblem} />
              </div>
            </div>
            {voiceProblem && <span role="status" style={{ ...hintText, marginTop: -6, color: "var(--ink)" }}>{voiceProblem.text}</span>}
            {nearMax && <span id="goal-count" style={{ ...hintText, marginTop: -6 }}>
              <span style={FIG}>{q.length}</span> of <span style={FIG}>{QUESTION_MAX}</span> characters{q.length >= QUESTION_MAX ? ", the most a question can have." : "."}</span>}
            {/* Always mounted, so screen readers announce the text when it appears (a live region added with its text is
                often silent). Hidden while empty. */}
            <span id="replay-hint" role="status" style={offRecord ? { ...hintText, marginTop: -6 } : srOnly}>
              {offRecord ? "Replay plays only the recorded questions below. Pick one, or set Model to Live (needs the judge key) or Fake to ask your own." : ""}</span>
            <Field label="Model" hint="Live answers need the judge key. Replay and Fake are open to everyone.">
              <Segmented<Mode> active={mode} onChange={(m) => setProvider(m === "live" ? liveProv : m)}
                options={[{ value: "live", label: "Live" }, { value: "replay", label: "Replay" }, { value: "fake", label: "Fake" }]} />
            </Field>
            {glimmerAvailable && mode === "live" && (
              <Field label="Live model" hint="Muse Glimmer 30B has open weights and runs on our own GPU, which sleeps when idle: its first answer can take a few minutes.">
                <Segmented<string> active={liveProv} onChange={(v) => { setLastLive(v); setProvider(v); }}
                  options={[{ value: baseLive, label: MODEL_NAME[baseLive] ?? baseLive }, { value: "modal", label: MODEL_NAME.modal }]} />
              </Field>
            )}
            {(needsKey || voiceProblem?.key) && keyField}
            <Field label="Try">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => setQ(s)} style={{ ...inputBox, display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", textAlign: "left", fontSize: 14, lineHeight: "20px" }}>
                  <Sparkle size={16} weight="bold" aria-hidden="true" style={{ flex: "none", marginTop: 2, color: "var(--ink-muted)" }} />{s}
                </button>
              ))}
            </Field>
          </Pad>
        </Card>
        {replays.length > 0 && (
          <Card title="Recorded sessions">
            {replays.map((r) => (
              <Button variant="text" key={r.question} type="button" onClick={() => { setQ(r.question); setProvider("replay"); }}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", border: 0, borderBottom: "1px solid var(--hairline)", background: "transparent",
                  color: "var(--ink)", font: "inherit", textAlign: "left" }}>
                <ClockCounterClockwise size={18} weight="bold" aria-hidden="true" style={{ flex: "none", color: "var(--ink-muted)" }} />
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 14, lineHeight: "20px" }}>{r.question}</span>
                  <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{r.model} · {fmtRecorded(r.recorded_at)}</span>
                </span>
                <Badge>Replay</Badge>
              </Button>
            ))}
          </Card>
        )}
        <Footer><span style={{ flex: 1 }} /><Btn kind="primary" icon={<PaperPlaneTilt size={16} weight="bold" aria-hidden="true" />} disabled={!canAsk} aria-describedby={offRecord ? "replay-hint" : undefined} onClick={() => ask()}>Ask</Btn></Footer>
      </div>
    );
  }

  const rateLimited = !!err && wait > 0;
  return (
    <div ref={rootRef} style={stack}>
      <style>{CSS}</style>
      {replayed && (
        <Card title="Replay" right={<span style={{ marginLeft: "auto" }}><Badge>Replay</Badge></span>}>
          <div style={{ display: "flex", gap: 10, padding: 14 }}>
            <ClockCounterClockwise size={20} weight="bold" aria-hidden="true" style={{ flex: "none", color: "var(--ink-muted)" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13, lineHeight: "20px", color: "var(--ink-muted)" }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>Recorded live session</span>
              <span>{introMatch ? `${introMatch[1]} via ${introMatch[2]} · ${fmtRecorded(introMatch[3])}. ` : ""}Not a live model call; waits are shortened.</span>
            </div>
          </div>
        </Card>
      )}
      {!brief && (
        <>
          <Card title="Goal" right={<span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: rateLimited ? "var(--hazard)" : "var(--ink-muted)" }}>
            {rateLimited ? <><Dot color="var(--hazard)" />Rate-limited</> : <><Dot color="var(--verified)" />{mode === "live" ? "Live" : mode === "replay" ? "Replay" : "Fake"} · {modelName}</>}</span>}>
            <div style={{ padding: 14, fontSize: 14, lineHeight: "20px" }}>{q}</div>
          </Card>
          <Card title="Steps" right={<span style={{ ...FIG, marginLeft: "auto", fontSize: 13, color: "var(--ink-muted)" }}>
            {steps.length} {steps.length === 1 ? "step" : "steps"}</span>}>
            <Stepper steps={steps} running={busy} thought={thought} now={now} onRun={onRun} writing={writing} />
            {steps.length === 0 && !thought && !writing && <div style={{ padding: 14, fontSize: 13, color: "var(--ink-muted)" }}>{busy ? "Waiting for the first step." : "No steps yet."}</div>}
          </Card>
        </>
      )}
      {brief && <><BriefCard brief={brief} />{briefExtra}<ClaimsCard brief={brief} /></>}
      {err && (
        <Card title="Live model" right={<span data-agent-failure style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--hazard)" }}>
          <Dot color="var(--hazard)" />{wait > 0 || (lock && err.code === "rate_limited") ? "Rate-limited" : "Unavailable"}</span>}>
          <Notice message={lock && err.code === "rate_limited" ? lockoutText(lock.scope, lock.leftS) : err.message} wait={wait} total={waitTotal}
            detail={wait > 0 ? <>Retrying in <span style={FIG}>{wait}</span> s.</> : undefined} note="Your steps so far are kept.">
            {err.retryable && <Btn kind="raised" icon={<ArrowClockwise size={16} weight="bold" aria-hidden="true" />} disabled={busy || wait > 0} onClick={() => ask()}>Retry now</Btn>}
            {(FAKE_HELPS.includes(err.code) || (!!lock && err.code === "rate_limited")) && provider !== "fake" &&
              <Btn kind="ghost" icon={<Flask size={16} weight="bold" aria-hidden="true" />} disabled={busy} onClick={useFake}>Use the fake agent</Btn>}
          </Notice>
          {needsKey && <Pad>{keyField}</Pad>}
        </Card>
      )}
      <Footer>
        {brief ? (
          <>
            <Btn kind="raised" icon={<Columns size={16} weight="bold" aria-hidden="true" />}
              onClick={() => { const id = brief.recommended_run_id ?? brief.claims?.find((c: any) => c.source_run_id)?.source_run_id; if (id) onRun(id); }}>Compare on map</Btn>
            <Btn kind="ghost" icon={<Copy size={16} weight="bold" aria-hidden="true" />} onClick={copy}>{copied ? "Copied" : "Copy"}</Btn>
            <span style={{ flex: 1 }} /><Btn kind="ghost" onClick={reset}>New</Btn>
          </>
        ) : (
          <>
            {budget ? (
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ ...FIG, display: "flex", fontSize: 13, color: "var(--ink-muted)" }}>
                  <span>Runs {budget.runs_used} of {budget.runs_max} · {mmss(budget.elapsed_s)} of {mmss(budget.deadline_s)}</span></div>
                <div role="progressbar" aria-label="Run budget" aria-valuemin={0} aria-valuemax={budget.runs_max} aria-valuenow={budget.runs_used}
                  style={{ height: 3, borderRadius: 2, background: "var(--hairline)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${budget.runs_max ? Math.min(100, (budget.runs_used / budget.runs_max) * 100) : 0}%`, background: "var(--danfo)" }} /></div>
              </div>
            ) : <span style={{ flex: 1 }} />}
            {busy ? <Btn kind="raised" icon={<Stop size={16} weight="bold" aria-hidden="true" />} onClick={() => { stopRef.current = true; }}>Stop</Btn>
              : <Btn kind="ghost" onClick={reset}>New question</Btn>}
          </>
        )}
      </Footer>
    </div>
  );
}

// Built once: toLocale*String with options builds a new formatter per call, and this runs for every recording on
// every render of the panel.
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

/** "2026-10-29T20:20:45+00:00" -> "29 Oct, 20:20 UTC"; unparseable input is shown as given. */
function fmtRecorded(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DAY.format(d)}, ${TIME.format(d)} UTC`;
}
