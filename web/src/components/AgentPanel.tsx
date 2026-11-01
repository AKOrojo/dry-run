// Agent panel (rev5 restyle: docs/design/rev5-ref/Agent.dc.html). Four states: Ask, Working, Brief, Replay and failure.
// Unverified claims render greyed with a warning: the fail-closed rule is visible to judges.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ClockCounterClockwise, Copy, Key, PaperPlaneTilt, Columns, Flask, ArrowClockwise, Sparkle, Stop } from "@phosphor-icons/react";
import { ApiError, askAgent, AgentEvent, getJudgeKey, getReplays, QUESTION_MAX, Replay, setJudgeKey } from "../lib/api";
import { lockoutText, useLockout } from "../lib/lockout";
import { LockoutNote } from "./LockoutNote";
import { Notice } from "./Notice";
import { Card, Field, Segmented, FIG, hintText } from "./rev5";
import { Badge, Btn, Dot, Footer, Pad } from "./agent/bits";
import { BriefCard, ClaimsCard, briefText } from "./agent/Brief";
import { Stepper, buildSteps, lastBudget, mmss } from "./agent/Steps";
import { TextField } from "./controls/TextField";

// Server error codes (dryrun/api/errors.py) that the fake agent sidesteps.
const FAKE_HELPS = ["llm_auth", "llm_not_configured", "llm_unavailable"];
type Failure = { code: string; message: string; retryable: boolean; retry_after_s?: number };
type Mode = "live" | "replay" | "fake";

const SUGGESTIONS = ["Which places flood first?", "Compare new drains with green space in Lekki Phase 1", "Is Admiralty Way passable at the peak?"];
const MODEL_NAME: Record<string, string> = { meta: "Muse Spark 1.3", openrouter: "Muse Spark Open" };
const CSS = `@keyframes dr-spin{to{transform:rotate(360deg)}}@keyframes dr-indet{0%{margin-left:-40%}100%{margin-left:100%}}
.dr-spin{animation:dr-spin 1s linear infinite}.dr-indet{animation:dr-indet 1.4s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.dr-spin,.dr-indet{animation:none}}`;

const inputBox = { background: "var(--ground)", border: "1px solid var(--control-edge)", borderRadius: "var(--radius-md)",
  boxShadow: "inset 0 1px 2px var(--elev-drop-soft)", color: "var(--ink)", font: "inherit" } as const;

export function AgentPanel({ onRun, onAoi, onReplay, onEvents, briefExtra, defaultProvider, aoiId, judgeKeyRequired = false }:
  { onRun: (runId: string) => void; onAoi?: (aoiId: string) => void; onReplay?: (replayed: boolean) => void;
    /** The session's events so far (Agent mode's runs card, dock charts and log read them). */
    onEvents?: (events: AgentEvent[]) => void;
    /** Shown under the brief (the per-run bars for the studied place). */
    briefExtra?: ReactNode;
    defaultProvider: string; aoiId?: string; judgeKeyRequired?: boolean }) {
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState(defaultProvider);
  useEffect(() => setProvider(defaultProvider), [defaultProvider]);
  const liveProv = provider === "fake" || provider === "replay" ? (defaultProvider === "fake" || defaultProvider === "replay" ? "meta" : defaultProvider) : provider;
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
  const keyRef = useRef<HTMLInputElement>(null);
  const lock = useLockout();
  const keyProvider = provider !== "fake" && provider !== "replay";  // Replay and Fake never send a key: never locked
  const needsKey = (judgeKeyRequired || err?.code === "forbidden" || !!lock) && keyProvider;
  useEffect(() => { if (err?.code === "forbidden") keyRef.current?.focus(); }, [err]);
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
            <TextField multiline aria-label="Goal" value={q} onChange={(e) => setQ(e.target.value)} rows={4} placeholder="Describe what you want the planner to find out."
              maxLength={QUESTION_MAX} aria-describedby={nearMax ? "goal-count" : undefined}
              style={{ fontSize: 14, lineHeight: "20px" }} />
            {nearMax && <span id="goal-count" style={{ ...hintText, marginTop: -6 }}>
              <span style={FIG}>{q.length}</span> of <span style={FIG}>{QUESTION_MAX}</span> characters{q.length >= QUESTION_MAX ? ", the most a question can have." : "."}</span>}
            <Field label="Model" hint="Live answers need the judge key. Replay and Fake are open to everyone.">
              <Segmented<Mode> active={mode} onChange={(m) => setProvider(m === "live" ? liveProv : m)}
                options={[{ value: "live", label: "Live" }, { value: "replay", label: "Replay" }, { value: "fake", label: "Fake" }]} />
            </Field>
            {needsKey && keyField}
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
              <button key={r.question} type="button" onClick={() => { setQ(r.question); setProvider("replay"); }}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", border: 0, borderBottom: "1px solid var(--hairline)", background: "transparent",
                  color: "var(--ink)", font: "inherit", textAlign: "left" }}>
                <ClockCounterClockwise size={18} weight="bold" aria-hidden="true" style={{ flex: "none", color: "var(--ink-muted)" }} />
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 14, lineHeight: "20px" }}>{r.question}</span>
                  <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{r.model} · {fmtRecorded(r.recorded_at)}</span>
                </span>
                <Badge>Replay</Badge>
              </button>
            ))}
          </Card>
        )}
        <Footer><span style={{ flex: 1 }} /><Btn kind="primary" icon={<PaperPlaneTilt size={16} weight="bold" aria-hidden="true" />} disabled={!canAsk} onClick={() => ask()}>Ask</Btn></Footer>
      </div>
    );
  }

  const rateLimited = !!err && wait > 0;
  return (
    <div style={stack}>
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
            <Stepper steps={steps} running={busy} thought={thought} now={now} onRun={onRun} />
            {steps.length === 0 && !thought && <div style={{ padding: 14, fontSize: 13, color: "var(--ink-muted)" }}>{busy ? "Waiting for the first step." : "No steps yet."}</div>}
          </Card>
        </>
      )}
      {brief && <><BriefCard brief={brief} />{briefExtra}<ClaimsCard brief={brief} /></>}
      {err && (
        <Card title="Live model" right={<span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--hazard)" }}>
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

/** "2026-10-29T20:20:45+00:00" -> "29 Oct, 20:20 UTC"; unparseable input is shown as given. */
function fmtRecorded(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}
