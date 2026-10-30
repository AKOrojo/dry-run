// Agent mode (rev 5 AgentMode.dc.html): the runs the planner made, per-run bar charts and the agent log.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Info } from "@phosphor-icons/react";
import { API } from "../lib/api";
import type { AgentEvent, RunManifest } from "../lib/api";
import { TOOLS } from "./agent/Steps";
import { Band, Card, FIG, mono } from "./rev5";
import { describeIv } from "./Sidebar";

/** What the agent session produced, in order: run ids, the recommended run, the place it studied most. */
export type Session = { runIds: string[]; recommended: string | null; place: string | null; calls: { name: string; args: any; runId?: string }[] };

export function deriveSession(events: AgentEvent[]): Session {
  const runIds: string[] = [];
  const calls: Session["calls"] = [];
  const places = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "tool_call") {
      calls.push({ name: e.data.name, args: e.data.arguments ?? {} });
      const p = e.data.arguments?.place;
      if (e.data.name === "get_area_stats" && typeof p === "string") places.set(p, (places.get(p) ?? 0) + 1);
    }
    if (e.kind === "tool_result" && e.data.name === "run_simulation" && typeof e.data.result?.run_id === "string") {
      const c = [...calls].reverse().find((x) => x.name === "run_simulation" && !x.runId);
      if (c) c.runId = e.data.result.run_id;
    }
    if (e.kind === "run_ready" && !runIds.includes(e.data.run_id)) runIds.push(e.data.run_id);
  }
  const brief = events.find((e) => e.kind === "brief")?.data;
  // The place the brief cites most, else the one the agent read most.
  const cited = new Map<string, number>();
  for (const c of brief?.claims ?? []) {
    const m = /^area:(.+):[a-z_]+$/.exec(c.field ?? "");
    if (m) cited.set(m[1], (cited.get(m[1]) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { runIds, recommended: brief?.recommended_run_id ?? null, place: top(cited) ?? top(places), calls };
}

/** One line per intervention: what it is and where ("40 mm/h new drains, whole area"). */
const where = (iv: any) => (typeof iv.place === "string" ? `in ${iv.place}` : iv.polygon ? "in a drawn area" : "whole area");
export function ivDetail(iv: any): string {
  if (iv.type === "drain_upgrade") {
    const parts = [iv.capacity_factor && iv.capacity_factor !== 1 ? `drains ×${iv.capacity_factor}` : null, iv.add_mm_h ? `${iv.add_mm_h} mm/h new drains` : null].filter(Boolean);
    const text = parts.join(" and ") || "drain upgrade";
    return `${text[0].toUpperCase()}${text.slice(1)}, ${where(iv)}`;
  }
  if (iv.type === "green") return `Green space ${where(iv)}`;
  if (iv.type === "pond") return `Pond ${where(iv)}`;
  if (iv.type === "road_closure") return `Road closed ${where(iv)}`;
  return describeIv(iv);
}
/** Short name from the interventions themselves ("New drains plus green space"); model-written labels vary too much. */
const ivName = (iv: any) => iv.type === "drain_upgrade" ? (iv.add_mm_h ? (iv.capacity_factor && iv.capacity_factor !== 1 ? `drains ×${iv.capacity_factor} and new drains` : "new drains") : `drains ×${iv.capacity_factor ?? "?"}`)
  : iv.type === "green" ? "green space" : iv.type === "pond" ? "a pond" : iv.type === "road_closure" ? "a road closure" : describeIv(iv).toLowerCase();
export const runTitle = (m: RunManifest) => {
  const ivs = m.scenario.interventions ?? [];
  if (!ivs.length) return "Baseline";
  const t = ivs.map(ivName).join(" plus ");
  return t[0].toUpperCase() + t.slice(1);
};
const runSub = (m: RunManifest) => (m.scenario.interventions?.length ? m.scenario.interventions.map(ivDetail).join("; ") : "No interventions");

/** Stat inside a named place for each run (GET /api/runs/{id}/area), keyed by run id. */
export function usePlaceStat(place: string | null, runIds: string[], stat = "road_km_impassable") {
  const [vals, setVals] = useState<Record<string, number>>({});
  const key = `${place}|${runIds.join(",")}`;
  useEffect(() => {
    setVals({});
    if (!place) return;
    let off = false;
    runIds.forEach((id) => fetch(`${API}/api/runs/${id}/area?place=${encodeURIComponent(place)}`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off && typeof d?.[stat] === "number") setVals((v) => ({ ...v, [id]: d[stat] })); }).catch(() => { /* bar stays empty */ }));
    return () => { off = true; };
  }, [key, stat]);  // runIds is captured in key
  return vals;
}

export function RunsCard({ runs, shown, recommended, onShow }: { runs: RunManifest[]; shown?: string; recommended: string | null; onShow: (m: RunManifest) => void }) {
  const backends = new Set(runs.map((m) => m.backend));
  const kind = (b: string) => (b === "solver" ? "solver" : b === "surrogate" ? "surrogate" : "placeholder");
  return (
    <Card title="Runs the planner made" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12, ...FIG }}>
      {runs.length} · {backends.size === 1 ? `all ${kind([...backends][0])}` : "mixed models"}</span>}>
      <ol data-tour="agent-runs" style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {runs.map((m, i) => {
          const on = m.run_id === shown;
          return (
            <li key={m.run_id}>
              <button type="button" aria-pressed={on} onClick={() => onShow(m)}
                style={{ width: "100%", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "2px 10px", padding: "9px 14px", border: 0, borderTop: i ? "1px solid var(--hairline)" : 0,
                  background: on ? "var(--surface-raised)" : "transparent", boxShadow: on ? "inset 3px 0 0 var(--danfo)" : undefined, color: "var(--ink)", font: "inherit", textAlign: "left", cursor: "pointer" }}>
                <span style={{ fontWeight: on ? 600 : 400, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={FIG}>{i + 1}</span> · {runTitle(m)}{m.run_id === recommended && <span style={{ color: "var(--danfo-text)", fontSize: 12, fontWeight: 600 }}> · recommended</span>}</span>
                <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>{kind(m.backend)}</span>
                <span style={{ gridColumn: "1 / -1", color: "var(--ink-muted)", fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{runSub(m)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** Run chip and run number buttons over the map. */
export function AgentMapOverlay({ runs, shown, picked, onShow }: { runs: RunManifest[]; shown?: string; picked: boolean; onShow: (m: RunManifest) => void }) {
  const i = runs.findIndex((m) => m.run_id === shown);
  if (i < 0) return null;
  const m = runs[i];
  const num = (k: number, on: boolean, size = 20) => (
    <span style={{ minWidth: size, height: size, padding: "0 4px", display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 3, fontSize: 11, fontWeight: 700,
      ...(on ? { background: "var(--danfo)", color: "var(--on-danfo)" } : { background: "transparent", color: "var(--ink-muted)" }), ...FIG }}>{k}</span>
  );
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: 84, left: 64, zIndex: 1, display: "flex", flexDirection: "column", gap: 2, padding: "8px 12px", maxWidth: 440, background: "var(--surface-raised)",
        border: "1px solid var(--danfo)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{num(i + 1, true, 18)}{runTitle(m)}</span>
        <span style={{ color: "var(--ink-muted)", fontSize: 12, whiteSpace: "nowrap" }}>Run {i + 1} of {runs.length} · <span style={{ fontFamily: mono, fontSize: 11 }}>{m.run_id}</span> · {picked ? "shown because you selected it" : "the latest run"}</span>
      </div>
      {runs.length > 1 && (
        <div role="group" aria-label="Show run" style={{ position: "absolute", top: 64, right: 16, zIndex: 1, display: "flex", gap: 2, padding: 3, background: "var(--surface)",
          border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--card-shadow)", pointerEvents: "auto" }}>
          {runs.map((r, k) => (
            <button key={r.run_id} type="button" aria-label={`Show run ${k + 1}`} aria-pressed={k === i} onClick={() => onShow(r)}
              style={{ width: 28, height: 26, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, border: 0, borderRadius: 3, background: "transparent", cursor: "pointer" }}>{num(k + 1, k === i)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

type Bar = { id: string; label: string; value: number | null };

/** Horizontal bars, one per run, scaled to the largest; the recommended run has a danfo outline. */
function Bars({ bars, color, fmt, shown, recommended, onPick, labelled = false }: {
  bars: Bar[]; color: string; fmt: (v: number) => string; shown?: string; recommended: string | null; onPick: (id: string) => void; labelled?: boolean;
}) {
  const max = Math.max(1e-9, ...bars.map((b) => b.value ?? 0));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: labelled ? 6 : 8 }}>
      {bars.map((b, k) => {
        const rec = b.id === recommended, on = b.id === shown;
        const pct = b.value == null ? 0 : (100 * b.value) / max;
        return (
          <button key={b.id} type="button" onClick={() => onPick(b.id)} title={rec ? "Recommended run" : undefined}
            style={{ display: "grid", gridTemplateColumns: labelled ? "minmax(0, 1fr) auto" : "14px minmax(0, 1fr) auto", alignItems: "center", gap: labelled ? "3px 10px" : 10,
              padding: 0, border: 0, background: "transparent", color: "var(--ink)", font: "inherit", textAlign: "left", cursor: "pointer" }}>
            {labelled ? <span style={{ fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: on ? 600 : 400 }}>{b.label}</span>
              : <span style={{ color: "var(--ink-muted)", fontSize: 12, ...FIG }}>{k + 1}</span>}
            {labelled && <span style={{ fontWeight: 600, fontSize: 13, ...FIG }}>{b.value == null ? "…" : fmt(b.value)}</span>}
            <span style={{ position: "relative", height: 12, borderRadius: 3, background: "var(--ground)", boxShadow: "var(--inset-shadow)", gridColumn: labelled ? "1 / -1" : undefined }}>
              <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.max(pct, b.value ? 2 : 0)}%`, borderRadius: 3, background: color,
                outline: rec ? "2px solid var(--danfo)" : undefined, outlineOffset: 1, opacity: on || !shown ? 1 : 0.75 }} />
            </span>
            {!labelled && <span style={{ minWidth: 52, textAlign: "right", fontSize: 13, fontWeight: rec ? 700 : 400, ...FIG }}>{b.value == null ? "…" : fmt(b.value)}</span>}
          </button>
        );
      })}
    </div>
  );
}

function lowestNote(bars: Bar[], zeroText: string): string | null {
  const vals = bars.filter((b) => b.value != null) as { id: string; value: number }[];
  if (vals.length < 2) return null;
  const k = bars.indexOf(bars.find((b) => b.id === vals.reduce((m, b) => (b.value < m.value ? b : m)).id)!);
  const min = vals.reduce((m, b) => Math.min(m, b.value), Infinity);
  return min > 0 ? `${zeroText} Run ${k + 1} is lowest.` : `Run ${k + 1} reaches zero.`;
}

function BarFigure({ title, unit, note, last, children }: { title: string; unit: string; note?: string | null; last?: boolean; children: ReactNode }) {
  return (
    <figure style={{ margin: 0, display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", minWidth: 0, borderRight: last ? undefined : "1px solid var(--hairline)", overflowY: "auto" }}>
      <figcaption style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
        <span style={{ fontWeight: 600 }}>{title}</span><span style={{ color: "var(--ink-muted)" }}>({unit})</span>
        <span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12, whiteSpace: "nowrap" }}>by run</span>
      </figcaption>
      {children}
      {note && <p style={{ margin: 0, color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>{note}</p>}
    </figure>
  );
}

const stat = (m: RunManifest, k: string) => (typeof m.stats?.[k] === "number" ? (m.stats[k] as number) : null);

/** Dock in Agent mode: per-run bars for the studied place, study-area roads and buildings, then the agent log. */
export function AgentDock({ runs, session, placeVals, shown, onShow }: {
  runs: RunManifest[]; session: Session; placeVals: Record<string, number>; shown?: string; onShow: (m: RunManifest) => void;
}) {
  const pick = (id: string) => { const m = runs.find((r) => r.run_id === id); if (m) onShow(m); };
  const common = { shown, recommended: session.recommended, onPick: pick };
  const placeBars = runs.map((m) => ({ id: m.run_id, label: runTitle(m), value: placeVals[m.run_id] ?? null }));
  const roadBars = runs.map((m) => ({ id: m.run_id, label: runTitle(m), value: stat(m, "road_km_impassable") }));
  const bldBars = runs.map((m) => ({ id: m.run_id, label: runTitle(m), value: stat(m, "buildings_flooded") }));
  const pond = runs.some((m) => m.scenario.interventions?.some((iv) => iv.type === "pond"));
  return (
    <div data-tour="timeline" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", background: "var(--surface)", borderTop: "1px solid var(--hairline)", minHeight: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${session.place ? 3 : 2}, minmax(0, 1fr))`, minHeight: 0 }}>
        {session.place && (
          <BarFigure title={`${session.place} impassable`} unit="km" note={lowestNote(placeBars, "No tested option reaches zero.")}>
            <Bars bars={placeBars} color="var(--hazard)" fmt={(v) => v.toFixed(3)} {...common} />
          </BarFigure>
        )}
        <BarFigure title="Roads impassable, study area" unit="km" note={pond ? "Roads through a pond count as cut." : lowestNote(roadBars, "")?.trim()}>
          <Bars bars={roadBars} color="var(--hazard)" fmt={(v) => v.toFixed(1)} {...common} />
        </BarFigure>
        <BarFigure last title="Buildings flooded" unit="study area" note="At or next to the building, ≥ 0.15 m.">
          <Bars bars={bldBars} color="var(--depth-3)" fmt={(v) => v.toLocaleString("en-GB")} {...common} />
        </BarFigure>
      </div>
      <AgentLog session={session} runs={runs} shown={shown} onShow={onShow} />
    </div>
  );
}

const LOG_ROWS = 7;

function AgentLog({ session, runs, shown, onShow }: { session: Session; runs: RunManifest[]; shown?: string; onShow: (m: RunManifest) => void }) {
  const [all, setAll] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const rows = all ? session.calls : session.calls.slice(0, LOG_ROWS);
  const runNo = (id?: string) => (id ? runs.findIndex((m) => m.run_id === id) + 1 : 0);
  const label = (c: Session["calls"][number]) => {
    if (c.name === "run_simulation") { const m = runs.find((r) => r.run_id === c.runId); if (!m) return "Ran a simulation"; const t = runTitle(m); return t === "Baseline" ? "Ran the baseline" : `Ran ${t[0].toLowerCase()}${t.slice(1)}`; }
    if (c.name === "get_area_stats" && typeof c.args.place === "string") return `Read ${c.args.place} stats`;
    return TOOLS[c.name]?.label ?? c.name;
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid var(--hairline)", minHeight: 0 }}>
      <Band title="Agent log" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12, ...FIG }}>{session.calls.length} calls</span>} />
      <ol ref={list} style={{ margin: 0, padding: "4px 0", listStyle: "none", overflowY: "auto", minHeight: 0 }}>
        {rows.map((c, k) => {
          const Ic = TOOLS[c.name]?.Icon ?? Info;
          const n = runNo(c.runId), on = !!c.runId && c.runId === shown;
          const m = runs.find((r) => r.run_id === c.runId);
          return (
            <li key={k} onClick={m ? () => onShow(m) : undefined}
              style={{ display: "grid", gridTemplateColumns: "22px 16px minmax(0, 1fr) auto", gap: 10, alignItems: "center", height: 28, padding: "0 12px 0 14px", cursor: m ? "pointer" : undefined,
                ...(on ? { background: "var(--surface-raised)", boxShadow: "inset 3px 0 0 var(--danfo)", fontWeight: 600 } : {}) }}>
              <span style={{ fontFamily: mono, fontSize: 11, color: "var(--ink-muted)" }}>{String(k + 1).padStart(2, "0")}</span>
              <Ic size={16} weight="bold" color="var(--ink-muted)" />
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label(c)}</span>
              <span style={{ fontSize: 12, color: "var(--ink-muted)", fontWeight: 400, ...FIG }}>{n > 0 ? `run ${n}` : ""}</span>
            </li>
          );
        })}
      </ol>
      {session.calls.length > LOG_ROWS && (
        <button type="button" onClick={() => setAll((v) => !v)} style={{ margin: "0 14px 10px", padding: 0, border: 0, background: "transparent", color: "var(--ink-muted)", font: "inherit", textAlign: "left", cursor: "pointer" }}>
          {all ? "Show fewer" : `${session.calls.length - LOG_ROWS} more calls`}
        </button>
      )}
    </div>
  );
}

/** Inside the brief: the studied place's value for every run, labelled. */
export function BriefPlaceBars({ place, runs, vals, session, shown, onShow }: {
  place: string; runs: RunManifest[]; vals: Record<string, number>; session: Session; shown?: string; onShow: (m: RunManifest) => void;
}) {
  return (
    <Card title={`${place}, impassable at run max`} right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>km</span>}>
      <div style={{ padding: "12px 14px" }}>
        <Bars labelled bars={runs.map((m) => ({ id: m.run_id, label: runTitle(m), value: vals[m.run_id] ?? null }))} color="var(--hazard)" fmt={(v) => `${v.toFixed(3)} km`}
          shown={shown} recommended={session.recommended} onPick={(id) => { const m = runs.find((r) => r.run_id === id); if (m) onShow(m); }} />
      </div>
    </Card>
  );
}
