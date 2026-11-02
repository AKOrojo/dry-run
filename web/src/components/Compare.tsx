// Compare mode (rev 5 Compare.dc.html): pick runs A and B from this session, then B against A.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { ArrowCounterClockwise, Columns, House, RoadHorizon, Users, Waves } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import * as Cesium from "cesium";
import { API } from "../lib/api";
import type { AOIManifest, RunManifest } from "../lib/api";
import { Change, DIFF_MIN_M, PlaceRow } from "../lib/compare";
import { Button, fmtT } from "./ds";
import { Band, Card, FIG, mono } from "./rev5";
import { Select } from "./controls/Select";
import { runLabel } from "../lib/runlabel";
import { useShort } from "../lib/breakpoint";
import type { RunNames } from "../lib/streetpic";
import { Globe } from "./Globe";
import { Tooltip } from "./controls/Tooltip";
import { Button as CtlButton } from "./controls/Button";
import { ChartPicker } from "./Dock";
import type { ChartPick } from "./Dock";

export type CompareView = "A" | "B" | "Swipe" | "Side by side" | "Difference";

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

function RunSelect({ l, runs, labels, value, onChange }: { l: "A" | "B"; runs: RunManifest[]; labels?: Map<string, string>; value?: string; onChange: (id: string) => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1fr)", gap: 8, alignItems: "center" }}>
      <Letter l={l} />
      <Select label={`Run ${l}`} value={value} onChange={onChange} options={runs.map((m) => ({ value: m.run_id, label: labels?.get(m.run_id) ?? runLabel(m), detail: m.run_id, detailMono: true }))} />
    </div>
  );
}

export function CompareCard({ runs, labels, a, b, onA, onB, onSwap, busy, onScenario }: {
  runs: RunManifest[]; /** lib/runlabel.ts runLabels over `runs`. */ labels?: Map<string, string>; a?: string; b?: string; onA: (id: string) => void; onB: (id: string) => void; onSwap: () => void;
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
      <CtlButton variant="text" type="button" onClick={onSwap} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, padding: "3px 6px", background: "transparent", border: 0,
        color: "var(--ink-muted)", font: "inherit", fontSize: 12 }}><ArrowCounterClockwise size={13} weight="bold" />Swap</CtlButton>}>
      <div data-tour="compare-runs" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px" }}>
        <RunSelect l="A" runs={runs} labels={labels} value={a} onChange={onA} />
        <RunSelect l="B" runs={runs} labels={labels} value={b} onChange={onB} />
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

export function DeltaCard({ a, b, names }: { a: RunManifest; b: RunManifest; names?: RunNames }) {
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
        Run maxima. A: {names?.a ?? runLabel(a)} (<span style={{ fontFamily: mono, fontSize: 11 }}>{a.run_id}</span>). B: {names?.b ?? runLabel(b)} (<span style={{ fontFamily: mono, fontSize: 11 }}>{b.run_id}</span>).
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
function RunTag({ l, m, name, origin, style }: { l: "A" | "B"; m: RunManifest; name: string; origin: string; style: CSSProperties }) {
  return (
    <div aria-label={`Run ${l}: ${name}`} style={{ position: "absolute", zIndex: 1, display: "flex", flexDirection: "column", gap: 2, padding: "8px 12px", maxWidth: 360, background: "var(--surface-raised)",
      border: `1px solid ${l === "B" ? "var(--danfo)" : "var(--hairline)"}`, borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", pointerEvents: "none", ...style }}>
      {/* A long label ends in an ellipsis; the full one is in the tooltip (the only part of the tag that takes the pointer). */}
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, minWidth: 0 }}><Letter l={l} size={18} />
        <Tooltip text={name}><span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, pointerEvents: "auto" }}>{name}</span></Tooltip></span>
      <span style={{ color: "var(--ink-muted)", fontSize: 12, whiteSpace: "nowrap" }}><span style={{ fontFamily: mono, fontSize: 11 }}>{m.run_id}</span> · {origin}</span>
    </div>
  );
}

/** Phone: A and B in one card, clear of the right-edge buttons: under the map's toolbar and run badge, or beside the
 *  toolbar on a phone on its side (the map is too short to stack them over the view switch). One line per run (the
 *  pickers below show the id and where it came from; the row's aria-label says it too). */
function PhoneRuns({ rows }: { rows: { l: "A" | "B"; name: string; origin: string }[] }) {
  const el = useRef<HTMLDivElement>(null);
  const short = useShort();
  const [at, setAt] = useState({ top: 112, left: 12 });
  useLayoutEffect(() => {
    const box = el.current?.parentElement;
    if (!box) return;
    // A chip the declutter hid (visibility: hidden) still takes room in the stack: count only the ones that show.
    const shows = (e: Element) => { const cs = getComputedStyle(e); return cs.visibility !== "hidden" && cs.opacity !== "0" && e.getBoundingClientRect().height > 0; };
    const place = () => {
      const o = box.getBoundingClientRect();
      const bar = document.querySelector<HTMLElement>("[data-map-toolbar]");
      const stack = document.querySelector<HTMLElement>("[data-chip-stack]");
      const marks = [...(bar ? [bar] : []), ...(stack ? [...stack.children] : [])].filter(shows).map((e) => e.getBoundingClientRect());
      const next = short && bar ? { top: Math.round(bar.getBoundingClientRect().top - o.top), left: Math.round(bar.getBoundingClientRect().right - o.left + 8) }
        : marks.length ? { top: Math.round(Math.max(...marks.map((r) => r.bottom)) - o.top + 8), left: 12 } : null;
      if (next) setAt((p) => (p.top === next.top && p.left === next.left ? p : next));
    };
    place();
    const ro = new ResizeObserver(place);
    document.querySelectorAll("[data-map-toolbar], [data-chip-stack]").forEach((m) => ro.observe(m));
    ro.observe(box);
    // A chip shown or hidden by the declutter changes no size: watch its style and class too.
    const mo = new MutationObserver(place);
    const stack = document.querySelector("[data-chip-stack]");
    if (stack) mo.observe(stack, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [short]);
  return (
    <div ref={el} data-declutter-block="" style={{ position: "absolute", top: at.top, left: at.left, right: 64, zIndex: 2, display: "flex", flexDirection: "column", background: "var(--surface-raised)",
      border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", pointerEvents: "none" }}>
      {rows.map(({ l, name, origin }, i) => (
        <div key={l} role="group" aria-label={`Run ${l}: ${name}, ${origin}`} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, height: 32, padding: "0 10px",
          borderTop: i ? "1px solid var(--hairline)" : undefined }}>
          <Letter l={l} size={18} />
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, fontWeight: 600, fontSize: 13 }}>{name}</span>
        </div>
      ))}
    </div>
  );
}

/** Phone Side by side: each pane's run, at the pane's bottom-left above the view switch (one line, the card row's look). */
function PaneLabel({ l, name, origin, bottom }: { l: "A" | "B"; name: string; origin: string; bottom: number }) {
  return (
    <div role="group" aria-label={`Run ${l}: ${name}, ${origin}`} data-declutter-block="" style={{ position: "absolute", bottom, left: l === "A" ? 12 : "calc(50% + 12px)",
      maxWidth: "calc(50% - 24px)", zIndex: 2, display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 10px", boxSizing: "border-box", minWidth: 0,
      background: "var(--surface-raised)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", pointerEvents: "none" }}>
      <Letter l={l} size={18} />
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, fontWeight: 600, fontSize: 13 }}>{name}</span>
    </div>
  );
}

/** A and B labels, the view switch, and the swipe handle or difference legend, over the map. */
export function CompareMapOverlay({ phone = false, a, b, names, origin, view, onView, split, onSplit }: {
  /** One runs card in place of the two chips (they overlap at phone widths). */ phone?: boolean;
  a: RunManifest; b: RunManifest; names?: RunNames; origin: (m: RunManifest) => string; view: CompareView; onView: (v: CompareView) => void;
  split: number; onSplit: (v: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Phone Side by side: the pane labels sit just above the view switch (which spans the panes' bottom-left).
  const switchEl = useRef<HTMLDivElement>(null);
  const [labelsBottom, setLabelsBottom] = useState(98);
  useLayoutEffect(() => {
    const sw = switchEl.current;
    if (!phone || view !== "Side by side" || !sw || !box.current) return;
    const place = () => setLabelsBottom(Math.round(box.current!.getBoundingClientRect().bottom - sw.getBoundingClientRect().top + 8));
    place();
    const ro = new ResizeObserver(place);
    ro.observe(sw); ro.observe(box.current);
    return () => ro.disconnect();
  }, [phone, view]);
  const drag = (e: PointerEvent) => { const r = box.current!.getBoundingClientRect(); onSplit(Math.min(0.95, Math.max(0.05, (e.clientX - r.left) / r.width))); };
  const views: CompareView[] = ["A", "B", "Swipe", "Side by side", "Difference"];
  const left = view === "Swipe" || view === "Side by side";
  return (
    <div ref={box} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {phone && view === "Side by side" ? <>
        <PaneLabel l="A" name={names?.a ?? runLabel(a)} origin={origin(a)} bottom={labelsBottom} />
        <PaneLabel l="B" name={names?.b ?? runLabel(b)} origin={origin(b)} bottom={labelsBottom} />
      </> : phone ? <PhoneRuns rows={[
        ...(left || view === "A" || view === "Difference" ? [{ l: "A" as const, name: names?.a ?? runLabel(a), origin: origin(a) }] : []),
        ...(left || view === "B" || view === "Difference" ? [{ l: "B" as const, name: names?.b ?? runLabel(b), origin: origin(b) }] : []),
      ]} /> : <>
        {(left || view === "A" || view === "Difference") && <RunTag l="A" m={a} name={names?.a ?? runLabel(a)} origin={origin(a)} style={{ top: 84, left: 64 }} />}
        {(left || view === "B" || view === "Difference") && <RunTag l="B" m={b} name={names?.b ?? runLabel(b)} origin={origin(b)} style={{ top: 64, right: 16 }} />}
      </>}
      {view === "Swipe" && (
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${100 * split}%`, width: 0, zIndex: 1 }}>
          <span style={{ position: "absolute", top: 0, bottom: 0, left: -1, width: 2, background: "var(--danfo)" }} />
          <CtlButton variant="icon" type="button" aria-label="Drag to swipe between A and B" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => { if (e.buttons) drag(e); }}
            onKeyDown={(e) => { if (e.key === "ArrowLeft") onSplit(Math.max(0.05, split - 0.05)); if (e.key === "ArrowRight") onSplit(Math.min(0.95, split + 0.05)); }}
            style={{ position: "absolute", top: "50%", left: -22, width: 44, height: 44, marginTop: -22, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, borderRadius: "50%",
              background: "var(--danfo)", color: "var(--on-danfo)", border: "1px solid var(--danfo-edge)", boxShadow: "var(--shadow-float)", cursor: "ew-resize", pointerEvents: "auto", touchAction: "none" }}>
            <Columns size={18} weight="bold" />
          </CtlButton>
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
      <div ref={switchEl} role="group" aria-label="Compare view" data-tour="compare-view" style={{ position: "absolute", left: 12, bottom: 44, zIndex: 1, display: "flex", gap: 2, padding: 3, background: "var(--surface)",
        border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--card-shadow)", pointerEvents: "auto" }}>
        {views.map((v) => {
          const on = v === view;
          return (
            <CtlButton variant="segment" pressed={on} key={v} type="button" onClick={() => onView(v)}
              style={{ height: 26, display: "flex", alignItems: "center", gap: 6, padding: v.length === 1 ? "0 8px 0 4px" : "0 10px", border: 0, borderRadius: 3, font: "inherit", fontSize: 12, whiteSpace: "nowrap",
                ...(on ? { background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", fontWeight: 600 } : { background: "transparent", color: "var(--ink-muted)" }) }}>
              {v.length === 1 ? <><Letter l={v as "A" | "B"} size={18} />Run {v}</> : v}
            </CtlButton>
          );
        })}
      </div>
    </div>
  );
}

// ---- dock slots ----
export function ByPlace({ rows, menu }: { rows: PlaceRow[] | null; /** The dock slot's "Choose chart" picks, when it has fewer than three. */ menu?: ChartPick[] }) {
  const shown = rows?.slice(0, 6) ?? [];
  return (
    <figure style={{ margin: 0, display: "flex", flexDirection: "column", gap: 4, padding: "10px 14px 8px", minWidth: 0, overflow: "hidden" }}>
      <figcaption style={{ display: "flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap", overflow: "hidden" }}>
        <span style={{ fontWeight: 600 }}>By place</span><Tooltip text="Road km impassable inside each place, run maximum"><span style={{ color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>road km, run max</span></Tooltip>
        {menu && <span style={{ marginLeft: "auto", display: "flex", alignSelf: "center", flex: "none" }}><ChartPicker menu={menu} /></span>}
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
              <Tooltip key={r.place} text={`${r.place}: ${pctChange(r.a, r.b)?.text ?? "no change"}`}><tr>
                <td style={{ padding: "2px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.place}</td>
                <td style={{ textAlign: "right", color: "var(--ink-muted)", ...FIG }}>{r.a.toFixed(1)}</td>
                <td style={{ textAlign: "right", fontWeight: 600, ...FIG }}>{r.b.toFixed(1)}</td>
                <td style={{ paddingLeft: 8 }}>
                  <span style={{ display: "block", height: 6, background: "var(--ground)", borderRadius: "var(--radius-pill)", boxShadow: "var(--inset-shadow)" }}>
                    <span style={{ display: "block", height: 6, width: `${100 * ch}%`, background: better ? "var(--verified)" : "var(--hazard)", borderRadius: "var(--radius-pill)" }} />
                  </span>
                </td>
              </tr></Tooltip>
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
  // Bumped by "Restart map" on this side only; the camera sync below follows the new viewer (and a restarted leader).
  const [mapGen, setMapGen] = useState(0);
  useEffect(() => {
    if (!leader || !v) return;
    v.scene.screenSpaceCameraController.enableInputs = false;  // driven by the left map
    v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    // Copy the whole camera, frustum included, so both halves show the same ground at the same scale.
    const sync = () => {
      if (v.isDestroyed() || leader.isDestroyed()) return;
      const c = leader.camera, t = v.camera;
      Cesium.Cartesian3.clone(c.positionWC, t.position);
      Cesium.Cartesian3.clone(c.directionWC, t.direction);
      Cesium.Cartesian3.clone(c.upWC, t.up);
      Cesium.Cartesian3.clone(c.rightWC, t.right);
      const f = t.frustum, lf = c.frustum;
      if (f instanceof Cesium.PerspectiveFrustum && lf instanceof Cesium.PerspectiveFrustum) {
        f.fov = lf.fov; f.aspectRatio = lf.aspectRatio; f.near = lf.near; f.far = lf.far;
      }
    };
    sync();
    return leader.scene.postRender.addEventListener(sync);
  }, [leader, v]);
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "var(--ground)" }}>
      <Globe key={mapGen} aoi={aoi} frames={frames} tS={tS} ionToken={ionToken} buildingsUrl={buildingsUrl} onViewer={setV}
        onRestart={() => setMapGen((g) => g + 1)}
        buildingDepthsUrl={run.building_depths ? `${runsBase.replace(/\/$/, "")}/${run.run_id}/${run.building_depths}` : undefined} />
    </div>
  );
}
