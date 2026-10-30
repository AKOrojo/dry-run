// Agent chat + verified brief (owner: Eng B for UI, Eng C for event semantics).
// Unverified claims render greyed with a warning: the fail-closed rule is visible to judges.
import { useEffect, useRef, useState } from "react";
import { ApiError, askAgent, AgentEvent, getJudgeKey, getReplays, Replay, setJudgeKey } from "../lib/api";
import { Notice } from "./Notice";
import { Button, ClaimItem, ProvenanceBadge } from "./ds";

// Friendly tool-trace labels; unknown names fall back to the raw name (kept in the title for audit).
const TOOL_LABEL: Record<string, string> = {
  get_aoi_info: "Read the study area", run_simulation: "Ran a simulation", get_run_stats: "Read run stats",
  get_area_stats: "Read stats for a place", compare_runs: "Compared two runs", compute_route: "Checked a route",
  surrogate_sweep: "Swept scenarios (surrogate)",
};

// Server error codes (dryrun/api/errors.py) that the fake agent sidesteps.
const FAKE_HELPS = ["llm_auth", "llm_not_configured", "llm_unavailable"];
type Failure = { code: string; message: string; retryable: boolean; retry_after_s?: number };

export function AgentPanel({ onRun, onAoi, onReplay, defaultProvider, aoiId, judgeKeyRequired = false }:
  { onRun: (runId: string) => void; onAoi?: (aoiId: string) => void; onReplay?: (replayed: boolean) => void;
    defaultProvider: string; aoiId?: string; judgeKeyRequired?: boolean }) {
  const [q, setQ] = useState("Does tripling drain capacity keep roads passable in a 120 mm / 3 h storm?");
  const [provider, setProvider] = useState(defaultProvider);
  useEffect(() => setProvider(defaultProvider), [defaultProvider]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Failure | null>(null);
  const [wait, setWait] = useState(0);  // seconds left before Retry is allowed (rate limits)
  useEffect(() => { if (wait > 0) { const t = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(t); } }, [wait]);
  const [key, setKey] = useState(getJudgeKey);
  const keyRef = useRef<HTMLInputElement>(null);
  const needsKey = (judgeKeyRequired || err?.code === "forbidden") && provider !== "fake" && provider !== "replay";
  useEffect(() => { if (err?.code === "forbidden") keyRef.current?.focus(); }, [err]);
  const [replays, setReplays] = useState<Replay[]>([]);
  useEffect(() => { if (provider === "replay") getReplays().then(setReplays, () => setReplays([])); }, [provider]);
  const replay = provider === "replay" ? replays.find((r) => r.question === q) : undefined;

  const fail = (f: Failure) => { setErr(f); setWait(f.retry_after_s ?? 0); };
  const ask = async (prov = provider) => {
    setBusy(true); setEvents([]); setErr(null); setWait(0);
    if (replay && replay.aoi_id !== aoiId) onAoi?.(replay.aoi_id);  // show the recording's own study area
    try {
      for await (const ev of askAgent(q, prov, aoiId)) {
        setEvents((p) => [...p, ev]);  // an error event keeps the claims and runs already streamed
        if (ev.kind === "run_ready") onRun(ev.data.run_id);
        if (ev.kind === "error") fail(ev.data);
      }
    } catch (e) {
      fail(e instanceof ApiError ? { code: e.code, message: e.message, retryable: e.retryable, retry_after_s: e.retryAfterS }
        : { code: "unavailable", message: "The server is busy. Try again.", retryable: true });
    } finally { setBusy(false); }
  };
  const useFake = () => { setProvider("fake"); ask("fake"); };
  const brief = events.find((e) => e.kind === "brief")?.data;
  const replayed = events.some((e) => e.kind === "thought" && e.data.replay);
  useEffect(() => { onReplay?.(replayed); }, [replayed]);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="dr-stack">
      <div className="dr-field">
        <label className="label dr-field-label" htmlFor="dr-model">Model</label>
        <select id="dr-model" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="meta">Muse Spark 1.3 (Meta API)</option>
          <option value="openrouter">Muse Spark Open (sovereign mode)</option>
          <option value="fake">Fake (offline)</option>
          <option value="replay">Recorded replay (fallback)</option>
        </select>
      </div>
      {needsKey && (
        <div className="dr-field">
          <label className="label dr-field-label" htmlFor="dr-key">Judge key</label>
          <input id="dr-key" ref={keyRef} type="password" autoComplete="off" value={key}
            onChange={(e) => { setKey(e.target.value); setJudgeKey(e.target.value.trim()); }} />
          <span className="caption dr-muted">Live models need a judge key. Fake (offline) is open to everyone.</span>
        </div>
      )}
      <div className="dr-field">
        <label className="label dr-field-label" htmlFor="dr-question">Question</label>
        {provider === "replay" ? (
          <select id="dr-question" value={replay ? q : ""} onChange={(e) => setQ(e.target.value)}>
            <option value="" disabled>Choose a recorded question</option>
            {replays.map((r) => <option key={r.question} value={r.question}>{r.question}</option>)}
          </select>
        ) : <textarea id="dr-question" value={q} onChange={(e) => setQ(e.target.value)} rows={3} />}
      </div>
      {replay && (
        <div className="dr-row">
          <ProvenanceBadge kind="synthetic">Replay</ProvenanceBadge>
          <span className="caption dr-muted">Recorded live session · {replay.model} · {replay.recorded_at}</span>
        </div>
      )}
      <Button variant="primary" disabled={busy || (needsKey && !key.trim()) || (provider === "replay" && !replay)} onClick={() => ask()}>
        {busy ? "Working" : "Ask"}
      </Button>
      <ol className="data dr-muted dr-list-plain">
        {events.filter((e) => e.kind === "tool_call").map((e, i) => <li key={i} title={e.data.name}>{TOOL_LABEL[e.data.name] ?? e.data.name}</li>)}
      </ol>
      {brief && (
        <div className="dr-stack">
          <h3 className="heading dr-brief-title">{brief.title}</h3>
          <p className="body dr-brief-text">{brief.summary}</p>
          <div>
            {brief.claims.map((c: any, i: number) => (
              <ClaimItem key={i} text={c.text} value={c.value ?? null} unit={c.unit} verified={!!c.verified}
                modelValue={c.model_value} sourceRunId={c.source_run_id ?? brief.recommended_run_id} />
            ))}
          </div>
          {brief.prose_has_digits && <span className="caption dr-muted">⚠ Title or summary contains numbers not backed by claims</span>}
          <span className="caption dr-muted">{replayed ? "REPLAY of " : ""}{brief.provider} · {brief.model}</span>
        </div>
      )}
      {err && (
        <Notice message={err.message}
          detail={wait > 0 ? <>Retry in <span className="figure">{wait} s</span></> : undefined}>
          {err.retryable && <Button disabled={busy || wait > 0} onClick={() => ask()}>Retry</Button>}
          {FAKE_HELPS.includes(err.code) && provider !== "fake" &&
            <Button disabled={busy} onClick={useFake}>Use the fake agent</Button>}
        </Notice>
      )}
    </div>
  );
}
