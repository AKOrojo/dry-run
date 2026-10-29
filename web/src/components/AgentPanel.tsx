// Agent chat + verified brief (owner: Eng B for UI, Eng C for event semantics).
// Unverified claims render greyed with a warning: the fail-closed rule is visible to judges.
import { useEffect, useState } from "react";
import { askAgent, AgentEvent, getJudgeKey, getReplays, Replay, setJudgeKey } from "../lib/api";

export function AgentPanel({ onRun, onAoi, defaultProvider, aoiId, judgeKeyRequired = false }:
  { onRun: (runId: string) => void; onAoi?: (aoiId: string) => void; defaultProvider: string; aoiId?: string;
    judgeKeyRequired?: boolean }) {
  const [q, setQ] = useState("Does tripling drain capacity keep roads passable in a 120 mm / 3 h storm?");
  const [provider, setProvider] = useState(defaultProvider);
  useEffect(() => setProvider(defaultProvider), [defaultProvider]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(getJudgeKey);
  const needsKey = judgeKeyRequired && provider !== "fake" && provider !== "replay";
  const [replays, setReplays] = useState<Replay[]>([]);
  useEffect(() => { if (provider === "replay") getReplays().then(setReplays, () => setReplays([])); }, [provider]);
  const replay = provider === "replay" ? replays.find((r) => r.question === q) : undefined;

  const ask = async () => {
    setBusy(true); setEvents([]); setErr(null);
    if (replay && replay.aoi_id !== aoiId) onAoi?.(replay.aoi_id);  // show the recording's own study area
    try {
      for await (const ev of askAgent(q, provider, aoiId)) {
        setEvents((p) => [...p, ev]);
        if (ev.kind === "run_ready") onRun(ev.data.run_id);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const brief = events.find((e) => e.kind === "brief")?.data;
  const replayed = events.some((e) => e.kind === "thought" && e.data.replay);

  return (
    <div>
      <h3>Planner agent</h3>
      <select value={provider} onChange={(e) => setProvider(e.target.value)}>
        <option value="meta">Muse Spark 1.3 (Meta API)</option>
        <option value="openrouter">Muse Spark Open (sovereign mode)</option>
        <option value="fake">Fake (offline)</option>
        <option value="replay">Recorded replay (fallback)</option>
      </select>
      {needsKey && (
        <div>
          <input type="password" placeholder="Judge key" autoComplete="off" value={key}
            onChange={(e) => { setKey(e.target.value); setJudgeKey(e.target.value.trim()); }} />
          <small> Live models need a judge key. Fake (offline) is open to everyone.</small>
        </div>
      )}
      {provider === "replay" ? (
        <select value={replay ? q : ""} onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }}>
          <option value="" disabled>Choose a recorded question</option>
          {replays.map((r) => <option key={r.question} value={r.question}>{r.question}</option>)}
        </select>
      ) : <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={3} style={{ width: "100%" }} />}
      {replay && <p><b>REPLAY</b>: a recorded live session ({replay.model}, recorded {replay.recorded_at}), not a live model call.</p>}
      <button disabled={busy || (needsKey && !key.trim()) || (provider === "replay" && !replay)} onClick={ask}>{busy ? "Working..." : "Ask"}</button>
      {err && <p role="alert">⚠ {err}</p>}
      <ol style={{ fontSize: 12 }}>
        {events.filter((e) => e.kind === "tool_call").map((e, i) => <li key={i}>{e.data.name}</li>)}
      </ol>
      {brief && (
        <div>
          <h4>{brief.title}</h4>
          <p>{brief.summary}</p>
          <ul>
            {brief.claims.map((c: any, i: number) => (
              <li key={i} style={{ opacity: c.verified ? 1 : 0.45 }}>
                {c.verified ? "✓" : "⚠ unverified"} {c.text}: <b>{c.value ?? "n/a"} {c.unit}</b>
                {!c.verified && c.model_value != null && <small> (model said {c.model_value})</small>}
              </li>
            ))}
          </ul>
          {brief.prose_has_digits && <p style={{ opacity: 0.45 }}>⚠ title or summary contains numbers not backed by claims</p>}
          <small>{replayed ? "REPLAY of " : ""}{brief.provider} · {brief.model}</small>
        </div>
      )}
    </div>
  );
}
