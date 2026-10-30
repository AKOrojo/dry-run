// Sidebar (rev 5 tabs() + cards): Layers / Inspect / Scenario / Sources.
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Clock, CloudRain, Play, Ruler, TrendUp, Waves } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { AOIManifest, RunManifest } from "../lib/api";
import { LayerKey, setImageryMode, setLayer, useLayers } from "../lib/layers";
import { useInspect } from "../lib/inspect";
import { useClock } from "../lib/clock";
import { Card, Checkbox, Field, FIG, mono, MiniSlider, NumberInput, Segmented, srOnly, TextAction } from "./rev5";
import { fmtT } from "./ds";
import { Notice } from "./Notice";
import { Button } from "./ds";

export type Pattern = "uniform" | "front_loaded" | "center_peaked";
export type Failure = { message: string; retryable: boolean };
const TABS = ["Layers", "Inspect", "Scenario", "Sources"] as const;
type Tab = (typeof TABS)[number];

function Tabs({ active, onTab }: { active: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav aria-label="Sidebar" style={{ display: "flex", alignItems: "flex-end", padding: "0 16px", background: "var(--surface)", borderBottom: "1px solid var(--hairline)", flex: "none" }}>
      {TABS.map((n) => {
        const on = n === active;
        const st: CSSProperties = on
          ? { color: "var(--ink)", fontWeight: 600, background: "var(--raised-bg)", boxShadow: "inset 0 -2px 0 var(--ink), inset 0 1px 0 var(--elev-hi)", borderRadius: "var(--radius-md) var(--radius-md) 0 0", padding: "0 12px" }
          : { color: "var(--ink-muted)", padding: "0 12px" };
        return <button key={n} type="button" aria-current={on ? "page" : undefined} onClick={() => onTab(n)}
          style={{ height: 38, marginRight: 4, marginTop: 6, background: "transparent", border: 0, font: "inherit", ...st }}>{n}</button>;
      })}
    </nav>
  );
}

// ---- layers ----
const svgThumb = (inner: ReactNode) => (
  <span style={{ width: 30, height: 30, flex: "none", borderRadius: "var(--radius-sm)", overflow: "hidden", background: "var(--ground)", boxShadow: "var(--tile-shadow)" }}>
    <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">{inner}</svg>
  </span>
);
const imgThumb = (name: string) => (
  <span style={{ width: 30, height: 30, flex: "none", borderRadius: "var(--radius-sm)", overflow: "hidden", position: "relative", boxShadow: "var(--tile-shadow)" }}>
    <img src={`/thumbs/${name}.png`} alt="" style={{ width: 30, height: 30, display: "block", objectFit: "cover" }} />
    <span style={{ position: "absolute", inset: 0, borderRadius: "var(--radius-sm)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }} />
  </span>
);
const ROADS_T = svgThumb(<><path d="M-2 22 C8 18 14 20 32 9" stroke="var(--hazard)" strokeWidth="2.5" fill="none" /><path d="M6 -2 L13 32" stroke="var(--control-edge)" strokeWidth="1.5" /><path d="M-2 8 L32 13" stroke="var(--control-edge)" strokeWidth="1.2" /></>);
const PLACES_T = svgThumb(<><path d="M5 6 L22 4 L26 20 L10 25 Z" fill="none" stroke="var(--ink-muted)" strokeWidth="1.3" strokeDasharray="2.5 2" /><circle cx="15" cy="14" r="2" fill="var(--ink)" /></>);
const ROUTE_T = svgThumb(<><path d="M4 25 C10 25 10 15 16 15 S22 5 27 5" stroke="var(--ground)" strokeWidth="5" fill="none" /><path d="M4 25 C10 25 10 15 16 15 S22 5 27 5" stroke="var(--route)" strokeWidth="2.5" fill="none" /></>);
const PHOTO_T = svgThumb(<><circle cx="10" cy="11" r="3" fill="var(--observed)" /><circle cx="21" cy="19" r="3" fill="var(--observed)" /><circle cx="12" cy="23" r="2" fill="var(--observed)" opacity=".6" /></>);
const ARRIVAL_T = svgThumb(<><rect width="30" height="30" fill="var(--hazard)" opacity=".28" /><path d="M0 18 C8 12 14 22 30 14 V30 H0z" fill="var(--hazard)" opacity=".55" /><path d="M0 24 C9 20 16 28 30 22 V30 H0z" fill="var(--hazard)" /></>);

const ROWS: { key: LayerKey; name: string; thumb: ReactNode; slider?: boolean; note?: string }[] = [
  { key: "water", name: "Water depth", thumb: imgThumb("water"), slider: true },
  { key: "buildings", name: "Buildings by depth", thumb: imgThumb("buildings"), slider: true },
  { key: "roads", name: "Impassable roads", thumb: ROADS_T, note: "≥ 0.30 m" },
  { key: "places", name: "Places", thumb: PLACES_T },
  { key: "arrival", name: "Time to flood", thumb: ARRIVAL_T, note: "Arrival map" },
  { key: "route", name: "Evacuation route", thumb: ROUTE_T },
  { key: "photos", name: "Photo observations", thumb: PHOTO_T, note: "None yet" },
  { key: "terrain", name: "Terrain (3D)", thumb: imgThumb("terrain") },
  { key: "imagery", name: "Aerial imagery", thumb: imgThumb("aerial"), slider: true },
];

function LayersCard() {
  const lay = useLayers();
  const imageryMode = lay.imageryMode;
  return (
    <section style={{ display: "flex", flexDirection: "column", flex: "none", padding: "4px 0", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: "var(--card-shadow)" }}>
      {ROWS.map((r) => {
        const { on, opacity } = lay[r.key];
        const pct = Math.round(opacity * 100);
        return (
          <label key={r.key} style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, height: 38, padding: "0 14px", color: on ? undefined : "var(--ink-muted)" }}>
            <input type="checkbox" checked={on} onChange={(e) => setLayer(r.key, { on: e.target.checked })} style={srOnly} />
            <Checkbox on={on} />
            <span style={{ display: "flex", opacity: on ? 1 : 0.45 }}>{r.thumb}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {r.slider ? (
                <>
                  <MiniSlider pct={pct} label={`${r.name} opacity`} onChange={(p) => setLayer(r.key, { opacity: p / 100 })} />
                  <span style={{ width: 34, textAlign: "right", fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{pct}%</span>
                </>
              ) : <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{r.note ?? ""}</span>}
            </span>
          </label>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 6px", marginTop: 4, borderTop: "1px solid var(--hairline)", fontSize: 12, color: "var(--ink-muted)" }}>
        Imagery
        <span style={{ display: "flex", marginLeft: "auto", padding: 2, gap: 2, background: "var(--ground)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)" }}>
          {(["colour", "greyscale"] as const).map((m) => {
            const on = imageryMode === m;
            return <button key={m} type="button" aria-pressed={on} onClick={() => setImageryMode(m)}
              style={{ height: 22, padding: "0 9px", border: 0, borderRadius: 3, font: "inherit", ...(on ? { background: "var(--ink)", color: "var(--ground)", fontWeight: 600 } : { background: "transparent", color: "var(--ink-muted)" }) }}>
              {m === "colour" ? "Colour" : "Greyscale"}</button>;
          })}
        </span>
      </div>
    </section>
  );
}

// ---- inspect ----
function Metric({ Ic, label, value, sub, color = "var(--ink)" }: { Ic: Icon; label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr)", columnGap: 8, padding: "10px 12px", minWidth: 0 }}>
      <span style={{ color: "var(--ink-muted)", paddingTop: 1 }}><Ic size={16} weight="bold" /></span>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>{label}</span>
        <span style={{ fontSize: 16, lineHeight: "22px", fontWeight: 600, color, ...FIG }}>{value}</span>
        {sub && <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>{sub}</span>}
      </span>
    </div>
  );
}
const m2 = (v: number | null) => (v == null ? "n/a" : `${v.toFixed(2)} m`);
const coord = (lat: number, lon: number) => `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`;

function CursorCard({ tS, passM }: { tS: number; passM: number }) {
  const i = useInspect();
  const empty = i == null;
  const vd = { borderLeft: "1px solid var(--hairline)" };
  return (
    <Card title="At the cursor" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>Hover · <span style={FIG}>{fmtT(tS)}</span></span>}>
      {i == null ? (
        <p style={{ margin: 0, padding: "14px", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>Hover the map</p>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <Metric Ic={Ruler} label="Depth now" value={m2(i.depth_m)} sub={i.wet_t != null ? `wet from ${fmtT(i.wet_t)}` : undefined}
              color={i.depth_m != null && i.depth_m >= passM ? "var(--hazard)" : "var(--ink)"} />
            <div style={vd}><Metric Ic={TrendUp} label="Run max" value={m2(i.max_m)} /></div>
            <div style={vd}><Metric Ic={Clock} label="Impassable" value={i.impassable_t != null ? fmtT(i.impassable_t) : "Never"} sub={`≥ ${passM.toFixed(2)} m`} /></div>
          </div>
          <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: "1px solid var(--hairline)", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
            Street cell at <span style={{ fontFamily: mono, fontSize: 11 }}>{coord(i.lat, i.lon)}</span>.
          </p>
        </>
      )}
    </Card>
  );
}

const describeIv = (iv: { type: string; [k: string]: unknown }) =>
  iv.type === "tide" ? `Sea level ${(iv.boundary_level_m as number) > 0 ? "+" : ""}${iv.boundary_level_m} m`
  : iv.type === "drain_upgrade" ? `Drains ×${iv.capacity_factor ?? "?"}`
  : iv.type === "green" ? "Green infrastructure" : iv.type === "pond" ? "Retention pond" : iv.type === "road_closure" ? "Road closure" : iv.type;
const PATTERN_LABEL = { uniform: "uniform", front_loaded: "front-loaded", center_peaked: "centre-peaked" };
const n0 = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-GB") : "n/a");

function OverviewCard({ run, aoi, passM, onEdit }: { run?: RunManifest; aoi?: AOIManifest; passM: number; onEdit: () => void }) {
  const s = run?.stats;
  const dl: [string, ReactNode][] = run ? [
    ["Run", <span style={{ fontFamily: mono, fontSize: 12 }}>{run.run_id}</span>],
    ["Storm", `${run.scenario.storm.total_mm} mm over ${run.scenario.storm.duration_h} h, ${PATTERN_LABEL[run.scenario.storm.pattern ?? "uniform"]}`],
    ["Interventions", run.scenario.interventions?.length ? run.scenario.interventions.map(describeIv).join(", ") : "None (baseline)"],
    ["Model", `${run.backend === "solver" ? "2D solver" : run.backend === "surrogate" ? "Surrogate" : "Placeholder"}${aoi ? ` · ${aoi.grid.cell_size_m} m cells` : ""}`],
    ["Buildings flooded", <><span style={FIG}>{n0(s?.buildings_flooded)}</span>{typeof s?.buildings_flooded_severe === "number" && <span style={{ color: "var(--ink-muted)" }}> · <span style={FIG}>{n0(s.buildings_flooded_severe)}</span> severe</span>}</>],
    ["People exposed", <span style={FIG}>{n0(s?.people_exposed)}</span>],
    ["Status", <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: run.status === "failed" ? "var(--hazard)" : "var(--verified)" }} />{run.status[0].toUpperCase() + run.status.slice(1)}</span>],
  ] : [];
  return (
    <Card title="Run overview" right={<TextAction onClick={onEdit}>Edit scenario</TextAction>}>
      {run ? (
        <>
          <dl style={{ margin: 0, padding: "10px 14px 12px", display: "grid", gridTemplateColumns: "112px minmax(0, 1fr)", rowGap: 7, columnGap: 10, fontSize: 13, lineHeight: "18px" }}>
            {dl.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt style={{ color: "var(--ink-muted)" }}>{k}</dt><dd style={{ margin: 0, minWidth: 0 }}>{v}</dd></div>)}
          </dl>
          <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: "1px solid var(--hairline)", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
            Thresholds are assumptions: flooded 0.15 m, impassable {passM.toFixed(2)} m, severe 0.5 m.
          </p>
        </>
      ) : <p style={{ margin: 0, padding: 14, color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>No run yet. Set a scenario and press Simulate.</p>}
    </Card>
  );
}

// ---- scenario ----
export type ScenarioProps = {
  rain: number; onRain: (v: number) => void; durationH: number; onDuration: (v: number) => void;
  pattern: Pattern; onPattern: (p: Pattern) => void;
  /** null = Normal (no tide intervention), otherwise the boundary level in metres. */
  level: number | null; onLevel: (v: number | null) => void;
  coastal: boolean; busy: boolean; canRun: boolean; onSimulate: () => void; err: Failure | null;
};

function StormCard(p: ScenarioProps) {
  return (
    <Card title="Storm" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", display: "flex" }}><CloudRain size={16} weight="bold" /></span>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 14px 14px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Rain total"><NumberInput label="Rain total" value={p.rain} unit="mm" min={20} max={250} onChange={p.onRain} /></Field>
          <Field label="Duration"><NumberInput label="Duration" value={p.durationH} unit="h" min={1} max={6} onChange={p.onDuration} /></Field>
        </div>
        <Field label="Time pattern" hint="Rain falls evenly over the whole area. The pattern only shapes it over time.">
          <Segmented<Pattern> active={p.pattern} onChange={p.onPattern}
            options={[{ value: "uniform", label: "Uniform" }, { value: "front_loaded", label: "Front-loaded" }, { value: "center_peaked", label: "Centre-peaked" }]} />
        </Field>
      </div>
    </Card>
  );
}

const PRESETS = [{ label: "Normal", v: null }, { label: "Spring high", v: 0.5 }, { label: "High + surge", v: 1.0 }, { label: "Extreme", v: 1.5 }] as const;
const SENS = [["Normal", "−0.5", "23.2", "30,202"], ["+0.5 m", "+0.5", "29.0", "30,406"], ["+1.0 m", "+1.0", "29.8", "30,595"], ["+1.5 m", "+1.5", "31.4", "31,061"]];

function LevelCard({ level, onLevel }: Pick<ScenarioProps, "level" | "onLevel">) {
  const v = level ?? -0.5;
  const pct = ((v + 0.5) / 2.0) * 100;
  const active = PRESETS.find((p) => p.v === level)?.label ?? null;
  return (
    <Card title="Lagoon / sea level" right={<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, color: "var(--ink-muted)", fontSize: 12 }}><Waves size={16} weight="bold" />Assumption</span>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 14px 12px" }}>
        <Field label="Preset">
          <Segmented<string> size={11.5} active={active} onChange={(l) => onLevel(PRESETS.find((p) => p.label === l)!.v)}
            options={PRESETS.map((p) => ({ value: p.label, label: p.label }))} />
        </Field>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ position: "relative", display: "block", height: 24 }}>
            <span style={{ position: "absolute", left: 0, right: 0, top: 10, height: 4, background: "var(--ground)", borderRadius: "var(--radius-pill)", boxShadow: "var(--inset-shadow)" }} />
            <span style={{ position: "absolute", left: 0, width: `${pct}%`, top: 10, height: 4, background: "var(--depth-3)", borderRadius: "var(--radius-pill)" }} />
            <span style={{ position: "absolute", left: `${pct}%`, top: 4, width: 16, height: 16, marginLeft: -8, borderRadius: "50%", background: "var(--raised-bg)", border: "1px solid var(--control-edge)", boxShadow: "var(--raised-shadow)" }} />
            <input type="range" min={-0.5} max={1.5} step={0.1} value={v} aria-label="Lagoon and sea level in metres" onChange={(e) => onLevel(Math.round(+e.target.value * 10) / 10)}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "pointer" }} />
          </span>
          <span style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-muted)", fontSize: 11, ...FIG }}><span>−0.5 m</span><span>+0.5</span><span>+1.5 m</span></span>
        </div>
        <p style={{ margin: 0, color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
          {level == null ? "No tide intervention. " : `Level ${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} m. `}
          Holds the lagoon and sea edge at one level for the whole run. A scenario level, not an observed tide. Coastal areas only.
        </p>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, borderTop: "1px solid var(--hairline)" }}>
        <thead><tr style={{ color: "var(--ink-muted)" }}>
          <th style={{ padding: "7px 0 4px 14px", textAlign: "left", fontWeight: 500 }}>Level</th>
          <th style={{ padding: "7px 8px 4px", textAlign: "right", fontWeight: 500 }}>Flooded km²</th>
          <th style={{ padding: "7px 14px 4px 8px", textAlign: "right", fontWeight: 500 }}>Buildings</th></tr></thead>
        <tbody>{SENS.map((r) => (
          <tr key={r[0]} style={r[0] === "+1.0 m" ? { background: "var(--surface-raised)" } : undefined}>
            <td style={{ padding: "5px 0 5px 14px", ...FIG }}>{r[1]} m</td>
            <td style={{ padding: "5px 8px", textAlign: "right", ...FIG }}>{r[2]}</td>
            <td style={{ padding: "5px 14px 5px 8px", textAlign: "right", ...FIG }}>{r[3]}</td></tr>))}
        </tbody>
      </table>
      <p style={{ margin: 0, padding: "8px 14px 10px", color: "var(--ink-muted)", fontSize: 11, lineHeight: "15px" }}>
        Sensitivity on 120 mm / 3 h. Ground height error (about 2 m) is larger than one step, so read this as a trend, not who floods.
      </p>
    </Card>
  );
}

function SimulateBar({ busy, canRun, onSimulate }: Pick<ScenarioProps, "busy" | "canRun" | "onSimulate">) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: "var(--card-shadow)", flex: "none" }}>
      <span style={{ color: "var(--ink-muted)", fontSize: 12, lineHeight: "16px" }}>2D solver · about 40 s, or instant if cached</span>
      <button type="button" disabled={busy || !canRun} onClick={onSimulate}
        style={{ marginLeft: "auto", height: 34, padding: "0 16px", display: "flex", alignItems: "center", gap: 8, opacity: busy || !canRun ? 0.6 : 1,
          background: "linear-gradient(180deg, color-mix(in srgb, var(--danfo) 88%, white) 0%, var(--danfo) 100%)", color: "var(--on-danfo)", border: "1px solid var(--danfo-edge)",
          borderRadius: "var(--radius-md)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 1px 2px var(--elev-drop), 0 2px 6px var(--elev-drop-soft)", font: "inherit", fontWeight: 600 }}>
        <Play size={14} weight="bold" />{busy ? "Simulating" : "Simulate"}
      </button>
    </div>
  );
}

// ---- sources ----
function SourcesCard({ sources }: { sources: string[] }) {
  return (
    <Card title="Sources">
      <ul style={{ margin: 0, padding: "10px 14px 12px", listStyle: "none", display: "flex", flexDirection: "column", gap: 7, fontSize: 13, lineHeight: "18px" }}>
        {sources.map((c, i) => <li key={i}>{c}</li>)}
        <li style={{ color: "var(--ink-muted)" }}>© OpenStreetMap contributors</li>
      </ul>
      <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: "1px solid var(--hairline)", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
        Built with Muse Spark Open. Not an operational warning system.
      </p>
    </Card>
  );
}

export function Sidebar({ aoi, run, scenario, sources }: {
  aoi?: AOIManifest; run?: RunManifest; scenario: ScenarioProps; sources: string[];
}) {
  const [tab, setTab] = useState<Tab>("Layers");
  const { t_s } = useClock();
  const passM = typeof run?.stats?.passability_threshold_m === "number" ? run.stats.passability_threshold_m : 0.3;
  return (
    <aside style={{ display: "flex", flexDirection: "column", background: "var(--ground)", borderLeft: "1px solid var(--hairline)", minHeight: 0, overflow: "hidden" }}>
      <Tabs active={tab} onTab={setTab} />
      <div style={{ flexGrow: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: 10 }}>
        {tab === "Layers" && <LayersCard />}
        {tab === "Inspect" && <><CursorCard tS={t_s} passM={passM} /><OverviewCard run={run} aoi={aoi} passM={passM} onEdit={() => setTab("Scenario")} /></>}
        {tab === "Scenario" && (
          <>
            <StormCard {...scenario} />
            {scenario.coastal && <LevelCard level={scenario.level} onLevel={scenario.onLevel} />}
            <SimulateBar busy={scenario.busy} canRun={scenario.canRun} onSimulate={scenario.onSimulate} />
            {scenario.err && (
              <Notice message={scenario.err.message}>
                {scenario.err.retryable && <Button disabled={scenario.busy} onClick={scenario.onSimulate}>Retry</Button>}
              </Notice>
            )}
          </>
        )}
        {tab === "Sources" && <SourcesCard sources={sources} />}
      </div>
    </aside>
  );
}
