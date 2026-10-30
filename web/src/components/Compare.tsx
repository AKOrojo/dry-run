// Compare mode (rev 5 Compare.dc.html): pick runs A and B from this session, then B against A.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { ArrowCounterClockwise, CaretDown, Columns, House, RoadHorizon, Users, Waves } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type * as Cesium from "cesium";
import { API } from "../lib/api";
import type { AOIManifest, RunManifest } from "../lib/api";
import { Change, DIFF_MIN_M, PlaceRow } from "../lib/compare";
import { Button, fmtT } from "./ds";
import { Band, Card, FIG, mono } from "./rev5";
import { describeIv } from "./Sidebar";
import { Globe } from "./Globe";

export type CompareView = "A" | "B" | "Swipe" | "Side by side" | "Difference";

const what = (m: RunManifest) => (m.scenario.interventions?.length ? m.scenario.interventions.map(describeIv).join(", ") : "Baseline");
/** "Baseline" or the interventions, then the storm: what a run is, in words. */
export const runLabel = (m: RunManifest) => `${what(m)} · ${m.scenario.storm.total_mm} mm / ${m.scenario.storm.duration_h} h`;

/** Change of B against A as a signed percentage, e.g. "−82%"; lower is better for every compared stat. */
export const pctChange = (a: number, b: number) => {
  if (!(a > 0)) return null;
  const p = Math.round((100 * (b - a)) / a);
  return { text: `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p)}%`, color: p < 0 ? "var(--verified)" : p > 0 ? "var(--hazard)" : "var(--ink-muted)", p };
};
const signed = (v: number, digits: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;

export function Letter({ l, size = 20 }: { l: "A" | "B"; size?: number }) {
  const st: CSSProperties = l === "B" ? { background: "var(--danfo)", color: "var(--on-danfo)" } : { background: "var(--surface-raised)", color: "var(--ink)" };
  return <span style={{ width: size, height: size, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 3, fontSize: 11, fontWeight: 700, ...st }}>{l}</span>;
}

function RunSelect({ l, runs, value, onChange }: { l: "A" | "B"; runs: RunManifest[]; value?: string; onChange: (id: string) => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr)", gap: 8, alignItems: "center" }}>
      <Letter l={l} />
      <span style={{ position: "relative", display: "flex", alignItems: "center", minWidth: 0 }}>
        <select aria-label={`Run ${l}`} value={value ?? ""} onChange={(e) => onChange(e.target.value)}
          style={{ appearance: "none", WebkitAppearance: "none", width: "100%", minWidth: 0, height: 32, padding: "0 28px 0 10px", background: "var(--raised-bg)", color: "var(--ink)",
            border: "1px solid var(--control-edge)", borderRadius: "var(--radius-md)", boxShadow: "var(--raised-shadow)", font: "inherit", textOverflow: "ellipsis" }}>
          {runs.map((m) => <option key={m.run_id} value={m.run_id}>{runLabel(m)}</option>)}
        </select>
        <CaretDown size={12} weight="bold" color="var(--ink-muted)" style={{ position: "absolute", right: 10, pointerEvents: "none" }} />
      </span>
    </div>
  );
}

export function CompareCard({ runs, a, b, onA, onB, onSwap, busy, onScenario }: {
  runs: RunManifest[]; a?: string; b?: string; onA: (id: string) => void; onB: (id: string) => void; onSwap: () => void;
  busy: boolean; onScenario: () => void;
}) {
  if (runs.length < 2) {
    return (
      <Card title="Compare runs">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10, padding: 14 }}>
          <p style={{ margin: 0, color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
            {busy ? "Loading the baseline for this storm." : "Run a second scenario to compare."}
          </p>
          {!busy && <Button onClick={onScenario}>Go to Scenario</Button>}
        </div>
      </Card>
    );
  }
  return (
    <Card title="Compare runs" right={
      <button type="button" onClick={onSwap} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, padding: "3px 6px", background: "transparent", border: 0,
        color: "var(--ink-muted)", font: "inherit", fontSize: 12 }}><ArrowCounterClockwise size={13} weight="bold" />Swap</button>}>
      <div data-tour="compare-runs" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px" }}>
        <RunSelect l="A" runs={runs} value={a} onChange={onA} />
        <RunSelect l="B" runs={runs} value={b} onChange={onB} />
      </div>
    </Card>
  );
}

function Tile({ Ic, label, a, b, fmt }: { Ic: Icon; label: string; a: number; b: number; fmt: (v: number) => string }) {
  const d = pctChange(a, b);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr)", columnGap: 8, padding: "10px 12px", minWidth: 0 }}>
      <span style={{ color: "var(--ink-muted)", paddingTop: 1 }}><Ic size={16} weight="bold" /></span>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>{label}</span>
        <span style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 16, lineHeight: "22px", fontWeight: 600, ...FIG }}>{fmt(b)}
          {d && <span style={{ color: d.color, fontSize: 12 }}>{d.text}</span>}</span>
        <span style={{ color: "var(--ink-muted)", fontSize: 11, ...FIG }}>was {fmt(a)}</span>
      </span>
    </div>
  );
}

const num = (m: RunManifest, k: string) => (typeof m.stats?.[k] === "number" ? (m.stats[k] as number) : 0);
const TILES: { k: string; label: string; Ic: Icon; fmt: (v: number) => string }[] = [
  { k: "buildings_flooded", label: "Buildings", Ic: House, fmt: (v) => v.toLocaleString("en-GB") },
  { k: "road_km_impassable", label: "Road km", Ic: RoadHorizon, fmt: (v) => v.toFixed(1) },
  { k: "people_exposed", label: "People", Ic: Users, fmt: (v) => v.toLocaleString("en-GB") },
  { k: "flooded_area_km2", label: "Flooded km²", Ic: Waves, fmt: (v) => v.toFixed(2) },
];

export function DeltaCard({ a, b }: { a: RunManifest; b: RunManifest }) {
  const ps = TILES.map((t) => pctChange(num(a, t.k), num(b, t.k))?.p ?? 0);
  const verdict: [string, string] = ps.every((p) => p <= 0) && ps.some((p) => p < 0) ? ["Better", "var(--verified)"]
    : ps.every((p) => p >= 0) && ps.some((p) => p > 0) ? ["Worse", "var(--hazard)"] : ps.every((p) => p === 0) ? ["No change", "var(--ink-muted)"] : ["Mixed", "var(--ink-muted)"];
  const line = "1px solid var(--hairline)";
  return (
    <Card title="B against A" right={<span style={{ marginLeft: "auto", color: verdict[1], fontSize: 12, fontWeight: 600 }}>{verdict[0]}</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        {TILES.map((t, i) => (
          <div key={t.k} style={{ borderLeft: i % 2 ? line : undefined, borderTop: i > 1 ? line : undefined }}>
            <Tile Ic={t.Ic} label={t.label} a={num(a, t.k)} b={num(b, t.k)} fmt={t.fmt} />
          </div>
        ))}
      </div>
      <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: line, color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
        Run maxima. A <span style={{ fontFamily: mono, fontSize: 11 }}>{a.run_id}</span>, B <span style={{ fontFamily: mono, fontSize: 11 }}>{b.run_id}</span>.
      </p>
    </Card>
  );
}

const BUDGET: [string, string][] = [["drained_volume_m3", "Extra drained"], ["stored_volume_end_m3", "Stored at the end"], ["boundary_outflow_m3", "Out to lagoon and sea"]];

export function WaterBudgetCard({ a, b }: { a: RunManifest; b: RunManifest }) {
  const [delta, setDelta] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let off = false;
    setDelta(null);
    fetch(`${API}/api/compare?base_run_id=${a.run_id}&alt_run_id=${b.run_id}`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!off) setDelta(d?.delta ?? null); }).catch(() => { /* card shows the loading line */ });
    return () => { off = true; };
  }, [a.run_id, b.run_id]);
  const drains = [a, b].some((m) => m.scenario.interventions?.some((iv) => iv.type === "drain_upgrade"));
  return (
    <Card title="Water budget">
      <dl style={{ margin: 0, padding: "10px 14px 12px", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", rowGap: 8, columnGap: 12, fontSize: 13, lineHeight: "18px" }}>
        {BUDGET.map(([k, label]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ color: "var(--ink-muted)" }}>{label}</dt>
            <dd style={{ margin: 0, textAlign: "right", ...FIG }}>{delta && typeof delta[k] === "number" ? `${signed(delta[k] / 1e6, 2)} M m³` : "…"}</dd>
          </div>
        ))}
      </dl>
      <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: "1px solid var(--hairline)", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
        B minus A, from /api/compare.{drains && " \"New drains\" is capacity the model adds, not an engineering design."}
      </p>
    </Card>
  );
}

// ---- map overlays ----
function RunTag({ l, m, origin, style }: { l: "A" | "B"; m: RunManifest; origin: string; style: CSSProperties }) {
  return (
    <div style={{ position: "absolute", zIndex: 1, display: "flex", flexDirection: "column", gap: 2, padding: "8px 12px", maxWidth: 360, background: "var(--surface-raised)",
      border: `1px solid ${l === "B" ? "var(--danfo)" : "var(--hairline)"}`, borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", pointerEvents: "none", ...style }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><Letter l={l} size={18} />{what(m)}</span>
      <span style={{ color: "var(--ink-muted)", fontSize: 12, whiteSpace: "nowrap" }}><span style={{ fontFamily: mono, fontSize: 11 }}>{m.run_id}</span> · {origin}</span>
    </div>
  );
}

/** A and B labels, the view switch, and the swipe handle or difference legend, over the map. */
export function CompareMapOverlay({ a, b, origin, view, onView, split, onSplit }: {
  a: RunManifest; b: RunManifest; origin: (m: RunManifest) => string; view: CompareView; onView: (v: CompareView) => void;
  split: number; onSplit: (v: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = (e: PointerEvent) => { const r = box.current!.getBoundingClientRect(); onSplit(Math.min(0.95, Math.max(0.05, (e.clientX - r.left) / r.width))); };
  const views: CompareView[] = ["A", "B", "Swipe", "Side by side", "Difference"];
  const left = view === "Swipe" || view === "Side by side";
  return (
    <div ref={box} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {(left || view === "A" || view === "Difference") && <RunTag l="A" m={a} origin={origin(a)} style={{ top: 64, left: 64 }} />}
      {(left || view === "B" || view === "Difference") && <RunTag l="B" m={b} origin={origin(b)} style={{ top: 64, right: 16 }} />}
      {view === "Swipe" && (
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${100 * split}%`, width: 0, zIndex: 1 }}>
          <span style={{ position: "absolute", top: 0, bottom: 0, left: -1, width: 2, background: "var(--danfo)" }} />
          <button type="button" aria-label="Drag to swipe between A and B" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => { if (e.buttons) drag(e); }}
            onKeyDown={(e) => { if (e.key === "ArrowLeft") onSplit(Math.max(0.05, split - 0.05)); if (e.key === "ArrowRight") onSplit(Math.min(0.95, split + 0.05)); }}
            style={{ position: "absolute", top: "50%", left: -22, width: 44, height: 44, marginTop: -22, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, borderRadius: "50%",
              background: "var(--danfo)", color: "var(--on-danfo)", border: "1px solid var(--danfo-edge)", boxShadow: "var(--shadow-float)", cursor: "ew-resize", pointerEvents: "auto", touchAction: "none" }}>
            <Columns size={18} weight="bold" />
          </button>
        </div>
      )}
      {view === "Side by side" && <span style={{ position: "absolute", top: 0, bottom: 0, left: "50%", width: 2, marginLeft: -1, background: "var(--hairline)" }} />}
      {view === "Difference" && (
        <div style={{ position: "absolute", left: 12, bottom: 84, zIndex: 1, display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px", background: "var(--surface-raised)",
          border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>Depth, B minus A</span>
          {([["var(--verified)", "Drier in B"], ["var(--hazard)", "Wetter in B"]] as const).map(([c, t]) => (
            <span key={t} style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 2, background: c }} />{t}</span>))}
          <span style={{ color: "var(--ink-muted)", ...FIG }}>Changes under {DIFF_MIN_M.toFixed(2)} m not shown</span>
        </div>
      )}
      <div role="group" aria-label="Compare view" data-tour="compare-view" style={{ position: "absolute", left: 12, bottom: 44, zIndex: 1, display: "flex", gap: 2, padding: 3, background: "var(--surface)",
        border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--card-shadow)", pointerEvents: "auto" }}>
        {views.map((v) => {
          const on = v === view;
          return (
            <button key={v} type="button" aria-pressed={on} onClick={() => onView(v)}
              style={{ height: 26, display: "flex", alignItems: "center", gap: 6, padding: v.length === 1 ? "0 8px 0 4px" : "0 10px", border: 0, borderRadius: 3, font: "inherit", fontSize: 12, whiteSpace: "nowrap",
                ...(on ? { background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", fontWeight: 600 } : { background: "transparent", color: "var(--ink-muted)" }) }}>
              {v.length === 1 ? <><Letter l={v as "A" | "B"} size={18} />Run {v}</> : v}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- dock slots ----
export function ByPlace({ rows }: { rows: PlaceRow[] | null }) {
  const shown = rows?.slice(0, 6) ?? [];
  return (
    <figure style={{ margin: 0, display: "flex", flexDirection: "column", gap: 4, padding: "10px 14px 8px", minWidth: 0, overflow: "hidden" }}>
      <figcaption style={{ display: "flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap", overflow: "hidden" }}>
        <span style={{ fontWeight: 600 }}>By place</span><span style={{ color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis" }} title="Road km impassable inside each place, run maximum">road km, run max</span>
      </figcaption>
      {rows == null ? <p style={{ margin: "auto", color: "var(--ink-muted)", fontSize: 12 }}>Loading places…</p>
        : !shown.length ? <p style={{ margin: "auto", color: "var(--ink-muted)", fontSize: 12 }}>This area has no named places.</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed" }}>
          <thead><tr style={{ color: "var(--ink-muted)" }}>
            <th style={{ textAlign: "left", fontWeight: 500, padding: "2px 0" }}>Place</th>
            <th style={{ width: 44, textAlign: "right", fontWeight: 500 }}>A</th><th style={{ width: 44, textAlign: "right", fontWeight: 500 }}>B</th><th style={{ width: "28%" }} /></tr></thead>
          <tbody>{shown.map((r) => {
            const ch = r.a > 0 ? Math.min(1, Math.abs(r.b - r.a) / r.a) : r.b > 0 ? 1 : 0;
            const better = r.b <= r.a;
            return (
              <tr key={r.place} title={`${r.place}: ${pctChange(r.a, r.b)?.text ?? "no change"}`}>
                <td style={{ padding: "2px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.place}</td>
                <td style={{ textAlign: "right", color: "var(--ink-muted)", ...FIG }}>{r.a.toFixed(1)}</td>
                <td style={{ textAlign: "right", fontWeight: 600, ...FIG }}>{r.b.toFixed(1)}</td>
                <td style={{ paddingLeft: 8 }}>
                  <span style={{ display: "block", height: 6, background: "var(--ground)", borderRadius: "var(--radius-pill)", boxShadow: "var(--inset-shadow)" }}>
                    <span style={{ display: "block", height: 6, width: `${100 * ch}%`, background: better ? "var(--verified)" : "var(--hazard)", borderRadius: "var(--radius-pill)" }} />
                  </span>
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </figure>
  );
}

const fmtChange = (c: Change, v: number | null) => (v == null ? "none" : c.kind === "time" ? fmtT(v) : v.toFixed(2));

/** Replaces Key events in Compare mode: each key moment in A and in B. */
export function WhatChanges({ changes, active }: { changes: Change[]; active: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid var(--hairline)", minHeight: 0, background: "var(--surface)" }}>
      <Band title="What changes" />
      <ol style={{ margin: "4px 0 0", padding: 0, listStyle: "none", overflowY: "auto" }}>
        {changes.map((c, i) => {
          const on = i === active;
          return (
            <li key={c.label} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "7px 12px 7px 14px",
              ...(on ? { background: "var(--surface-raised)", boxShadow: "inset 3px 0 0 var(--danfo), inset 0 1px 0 var(--elev-hi)" } : {}) }}>
              <span style={{ fontWeight: on ? 600 : 400 }}>{c.label}</span>
              <span style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12, color: "var(--ink-muted)" }}>
                <span style={{ whiteSpace: "nowrap", ...FIG }}>{fmtChange(c, c.a)} → <span style={{ color: "var(--ink)", fontWeight: 600 }}>{fmtChange(c, c.b)}</span>{c.kind === "km2" ? " km²" : ""}</span>
                {c.note && <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{c.note}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Side by side: the right-hand map (run B), following the main map's camera every frame. */
export function SideGlobe({ aoi, run, frames, tS, ionToken, buildingsUrl, runsBase, leader }: {
  aoi: AOIManifest; run: RunManifest; frames?: { t_s: number; url: string }[]; tS: number; ionToken: string; buildingsUrl?: string; runsBase: string;
  leader?: Cesium.Viewer;
}) {
  const [v, setV] = useState<Cesium.Viewer>();
  useEffect(() => {
    if (!leader || !v) return;
    v.scene.screenSpaceCameraController.enableInputs = false;  // driven by the left map
    const sync = () => {
      if (v.isDestroyed() || leader.isDestroyed()) return;
      const c = leader.camera;
      v.camera.setView({ destination: c.positionWC.clone(), orientation: { heading: c.heading, pitch: c.pitch, roll: c.roll } });
    };
    sync();
    return leader.scene.postRender.addEventListener(sync);
  }, [leader, v]);
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "var(--ground)" }}>
      <Globe aoi={aoi} frames={frames} tS={tS} ionToken={ionToken} buildingsUrl={buildingsUrl} onViewer={setV}
        buildingDepthsUrl={run.building_depths ? `${runsBase.replace(/\/$/, "")}/${run.run_id}/${run.building_depths}` : undefined} />
    </div>
  );
}
