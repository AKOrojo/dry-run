// Agent chat + verified brief (owner: Eng B for UI, Eng C for event semantics).
// Unverified claims render greyed with a warning: the fail-closed rule is visible to judges.
import { useEffect, useState } from "react";
import { askAgent, AgentEvent } from "../lib/api";

export function AgentPanel({ onRun, defaultProvider }: { onRun: (runId: string) => void; defaultProvider: string }) {
  const [q, setQ] = useState("Does tripling drain capacity keep roads passable in a 120 mm / 3 h storm?");
  const [provider, setProvider] = useState(defaultProvider);
  useEffect(() => setProvider(defaultProvider), [defaultProvider]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setBusy(true); setEvents([]);
    try {
      for await (const ev of askAgent(q, provider)) {
        setEvents((p) => [...p, ev]);
        if (ev.kind === "run_ready") onRun(ev.data.run_id);
      }
    } finally { setBusy(false); }
  };
  const brief = events.find((e) => e.kind === "brief")?.data;

  return (
    <div>
      <h3>Planner agent</h3>
      <select value={provider} onChange={(e) => setProvider(e.target.value)}>
        <option value="meta">Muse Spark 1.3 (Meta API)</option>
        <option value="baseten">Muse Spark Open (sovereign mode)</option>
        <option value="fake">Fake (offline)</option>
      </select>
      <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={3} style={{ width: "100%" }} />
      <button disabled={busy} onClick={ask}>{busy ? "Working..." : "Ask"}</button>
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
          <small>{brief.provider} · {brief.model}</small>
        </div>
      )}
    </div>
  );
}
