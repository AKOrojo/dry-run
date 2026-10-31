// Scenario tab: the "Rain area" card (where the rain falls) and the "Rain preview" card (what the model will be given).
import { useRef } from "react";
import type { CSSProperties } from "react";
import { CircleDashed, MapPin, NavigationArrow, Polygon, Target, Warning } from "@phosphor-icons/react";
import { Card, Field, FIG, mono, raisedButton, Segmented } from "./rev5";
import { Select } from "./controls/Select";
import { coord } from "./WaypointDetails";
import { compassOf, domainSwitchVisible, effectiveCentre, isCell, setMoving, setRain, setRainMode, useRain } from "../lib/rain";
import type { RainMode } from "../lib/rain";
import type { RainProfile } from "../lib/api";

const ghostBtn: CSSProperties = { ...raisedButton, height: 30, padding: "0 12px", display: "flex", alignItems: "center", gap: 6, borderRadius: "var(--radius-md)", font: "inherit", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", cursor: "pointer" };
const textBtn: CSSProperties = { padding: "3px 6px", background: "transparent", border: 0, borderRadius: "var(--radius-md)", color: "var(--ink-muted)", font: "inherit", fontSize: 12, fontWeight: 500, cursor: "pointer" };
const hint: CSSProperties = { margin: 0, color: "var(--ink-muted)", fontSize: 12, lineHeight: "16px" };

/** Slider drawn in danfo (a value the user sets), driven by an invisible native range input. */
export function Slider({ label, value, min, max, step, text, lo, hi, onChange }: { label: string; value: number; min: number; max: number; step: number; text: string; lo: string; hi: string; onChange: (v: number) => void }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-muted)" }}><span>{label}</span><span style={{ color: "var(--ink)", fontWeight: 600, ...FIG }}>{text}</span></span>
      <span style={{ position: "relative", display: "block", height: 24 }}>
        <span style={{ position: "absolute", left: 0, right: 0, top: 10, height: 4, background: "var(--ground)", borderRadius: "var(--radius-pill)", boxShadow: "var(--inset-shadow)" }} />
        <span style={{ position: "absolute", left: 0, width: `${pct}%`, top: 10, height: 4, background: "var(--danfo)", borderRadius: "var(--radius-pill)" }} />
        <span style={{ position: "absolute", left: `${pct}%`, top: 4, width: 16, height: 16, marginLeft: -8, borderRadius: "50%", background: "var(--raised-bg)", border: "1px solid var(--control-edge)", boxShadow: "var(--raised-shadow)" }} />
        <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(+e.target.value)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "pointer" }} />
      </span>
      <span style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-muted)", fontSize: 11, ...FIG }}><span>{lo}</span><span>{hi}</span></span>
    </div>
  );
}

export function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label style={{ position: "relative", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} style={{ position: "absolute", zIndex: 1, opacity: 0, width: 34, height: 20, margin: 0, cursor: "pointer" }} />
      <span aria-hidden="true" style={{ width: 34, height: 20, flex: "none", borderRadius: "var(--radius-pill)", position: "relative", boxShadow: "var(--inset-shadow)", background: on ? "var(--danfo)" : "var(--ground)" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: "50%", background: on ? "var(--on-danfo)" : "var(--ink-muted)" }} />
      </span>
      {label}
    </label>
  );
}

/** Click or drag the dial to set the heading the storm moves toward (0 = north, clockwise). */
function Dial({ deg, onChange }: { deg: number; onChange: (d: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const set = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const a = (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI;
    onChange(Math.round((a + 360) % 360));
  };
  const h = (deg * Math.PI) / 180, x = 24 + 16 * Math.sin(h), y = 24 - 16 * Math.cos(h);
  return (
    <svg ref={ref} width="48" height="48" viewBox="0 0 48 48" role="slider" aria-label="Heading" aria-valuemin={0} aria-valuemax={359} aria-valuenow={deg} tabIndex={0}
      style={{ flex: "none", cursor: "pointer", touchAction: "none" }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); set(e); }}
      onPointerMove={(e) => { if (e.buttons) set(e); }}
      onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); onChange((deg + 355) % 360); } else if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); onChange((deg + 5) % 360); } }}>
      <circle cx="24" cy="24" r="22" fill="var(--ground)" stroke="var(--control-edge)" strokeWidth="1.5" />
      <text x="24" y="10" textAnchor="middle" fontSize="7" fill="var(--ink-muted)">N</text>
      <line x1="24" y1="24" x2={x} y2={y} stroke="var(--danfo)" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx={x} cy={y} r="3.5" fill="var(--danfo)" />
      <circle cx="24" cy="24" r="2.5" fill="var(--ink)" />
    </svg>
  );
}

const km2 = (pts: [number, number][]) => {
  const lat0 = pts.reduce((a, p) => a + p[1], 0) / pts.length, kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.54;
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length]; a += x0 * kx * y1 * ky - x1 * kx * y0 * ky; }
  return Math.abs(a) / 2;
};

const MODES: { value: RainMode; label: string }[] = [
  { value: "whole", label: "Whole area" }, { value: "cell", label: "Storm cell" }, { value: "draw", label: "Draw area" }, { value: "place", label: "Place" },
];
const PROFILES: { value: RainProfile; label: string }[] = [{ value: "gaussian", label: "Gaussian" }, { value: "exponential", label: "Exponential" }, { value: "flat", label: "Flat" }];

function CellControls({ onPick }: { onPick?: boolean }) {
  const s = useRain();
  const c = effectiveCentre(s);
  const placeCell = s.mode === "place";
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Target size={18} weight="bold" color="var(--danfo)" style={{ flex: "none" }} />
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span style={{ color: "var(--ink-muted)" }}>Centre</span>
          <span style={{ fontFamily: mono, fontSize: 12, ...FIG }}>{placeCell ? (c ? coord(c[1], c[0]) : s.place) : c ? coord(c[1], c[0]) : "Not set"}</span>
        </span>
        {onPick && <button type="button" aria-pressed={s.picking === "centre"} onClick={() => setRain({ picking: s.picking === "centre" ? null : "centre" })} style={ghostBtn}>
          <MapPin size={14} weight="bold" />{s.picking === "centre" ? "Click the map" : "Pick on map"}</button>}
      </div>
      <Slider label="Radius" value={s.radius_m} min={1000} max={15000} step={500} text={`${+(s.radius_m / 1000).toFixed(1)} km`} lo="1 km" hi="15 km" onChange={(v) => setRain({ radius_m: v })} />
      <Field label="Falloff" hint="The dashed ring is where rain drops to 13.5 % of the centre. Flat: even rain inside the ring, none outside.">
        <Segmented<RainProfile> options={PROFILES} active={s.profile} onChange={(v) => setRain({ profile: v })} />
      </Field>
      <div style={{ display: "flex", alignItems: "center" }}>
        <Toggle on={s.moving} label="Moving storm" onChange={setMoving} />
        <span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>{s.lagos ? "Lagos default" : ""}</span>
      </div>
      {s.moving && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: 14, alignItems: "center" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Dial deg={s.heading_deg} onChange={(d) => setRain({ heading_deg: d })} />
              <span style={{ display: "flex", flexDirection: "column", ...FIG }}><span style={{ color: "var(--ink-muted)", display: "flex", alignItems: "center", gap: 4 }}><NavigationArrow size={12} weight="bold" />Toward</span>
                <span style={{ fontWeight: 600 }}>{compassOf(s.heading_deg)} · {Math.round(s.heading_deg)}°</span></span>
            </span>
            <Slider label="Speed" value={s.speed_m_s} min={0} max={20} step={0.5} text={`${s.speed_m_s} m/s`} lo="0" hi="20 m/s" onChange={(v) => setRain({ speed_m_s: v })} />
          </div>
          <p style={hint}>{s.lagos ? "Squall lines over Lagos move about 12 m/s toward the west. Drag the arrow on the map to steer."
            : "The cell moves in a straight line and is at its centre when the rain peaks. Drag the arrow on the map to steer."}</p>
        </>
      )}
    </>
  );
}

function DomainRow({ on, cells }: { on: boolean; cells: { domain: number; grid: number } | null }) {
  const note = !cells ? "faster" : cells.domain < cells.grid ? `${Math.round(cells.grid / cells.domain * 10) / 10}× fewer cells` : "whole area, no speed-up";
  return (
    <div data-tour="rain-domain" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Toggle on={on} label="Simulate this area only" onChange={(v) => setRain({ domainOnly: v })} />
        <span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12, whiteSpace: "nowrap", ...FIG }}>{note}</span>
      </div>
      {on && <p style={hint}>Only the rain window and 1 km around it are modelled. Water from outside does not flow in.</p>}
    </div>
  );
}

export function RainAreaCard({ hasInflows = false }: { hasInflows?: boolean }) {
  const s = useRain();
  return (
    <Card title="Rain area" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", display: "flex" }}><CircleDashed size={16} weight="bold" /></span>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 14px 14px" }}>
        <Segmented<RainMode> size={12} options={MODES} active={s.mode} onChange={setRainMode} />
        {domainSwitchVisible(s, hasInflows) && <DomainRow on={s.domainOnly} cells={s.estCells} />}
        {s.mode === "whole" && <p style={hint}>Rain falls evenly over the whole area. Choose a storm cell, a drawn area or a place to put it somewhere.</p>}
        {s.mode === "cell" && <CellControls onPick />}
        {s.mode === "draw" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Polygon size={18} weight="bold" color="var(--danfo)" style={{ flex: "none" }} />
              <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                <span style={{ color: "var(--ink-muted)" }}>Area</span>
                <span style={{ fontWeight: 600, ...FIG }}>{s.picking === "polygon" ? "Drawing on the map" : s.polygon ? `${s.polygon.length} points · ${km2(s.polygon).toFixed(1)} km²` : "Not drawn yet"}</span>
              </span>
              <button type="button" aria-pressed={s.picking === "polygon"} onClick={() => setRain({ picking: s.picking === "polygon" ? null : "polygon" })} style={ghostBtn}>
                <Polygon size={14} weight="bold" />{s.picking === "polygon" ? "Cancel" : s.polygon ? "Redraw" : "Draw on map"}</button>
            </div>
            {s.polygon && s.picking !== "polygon" && <span><button type="button" onClick={() => setRain({ polygon: null })} style={{ ...textBtn, padding: 0 }}>Clear</button></span>}
            <p style={hint}>{s.picking === "polygon" ? "Click to add points · Enter or double-click to finish · Backspace to undo · Esc to cancel."
              : "The rain total falls inside the area and none outside it."}</p>
          </>
        )}
        {s.mode === "place" && (
          <>
            <Field label="Place">
              <Select label="Place" value={s.place} onChange={(v) => setRain({ place: v })} disabled={!s.places.length}
                placeholder={s.places.length ? "Choose a place" : "No places in this area"} options={s.places.map((p) => ({ value: p.name, label: p.name }))} />
            </Field>
            {s.placeAsCell ? (
              <>
                <CellControls />
                <span><button type="button" onClick={() => setRain({ placeAsCell: false })} style={{ ...textBtn, padding: 0, color: "var(--ink)", textDecoration: "underline" }}>Rain over the whole place instead</button></span>
              </>
            ) : (
              <>
                <p style={hint}>The rain total falls inside this place and none outside it.</p>
                <span><button type="button" onClick={() => setRain({ placeAsCell: true })} style={{ ...textBtn, padding: 0, color: "var(--ink)", textDecoration: "underline" }}>Centre a storm cell here instead</button></span>
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

const pct = (v: number) => `${Math.round(v * 100)} %`;
export function RainPreviewCard() {
  const s = useRain();
  const f = s.preview;
  if (s.mode === "whole") return null;
  const rows: [string, string][] = f ? [
    [isCell(s) ? "At the centre" : "Deepest point", `${Math.round(f.max_point_mm)} mm`],
    ["Mean over land", `${Math.round(f.mean_land_mm)} mm`],
    ["Wet area", `${Math.round(f.wet_area_km2)} km²`],
    ["Peak intensity", `${Math.round(f.peak_intensity_mm_h)} mm/h`],
    ["Rain outside the model area", pct(f.outside_share)],
  ] : [];
  return (
    <Card title="Rain preview" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>{s.previewBusy ? "Updating" : "Before you simulate"}</span>}>
      {f ? (
        <dl style={{ margin: 0, padding: "10px 14px 12px", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", rowGap: 7, columnGap: 10, fontSize: 13, lineHeight: "18px", opacity: s.previewBusy ? 0.7 : 1 }}>
          {rows.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt style={{ color: "var(--ink-muted)" }}>{k}</dt><dd style={{ margin: 0, fontWeight: 600, ...FIG }}>{v}</dd></div>)}
        </dl>
      ) : (
        <p style={{ margin: 0, padding: 14, color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
          {s.previewErr ?? (s.mode === "draw" ? "Draw an area to see the rain." : s.previewBusy ? "Loading the preview…" : "Set the rain area to see the preview.")}</p>
      )}
      {f?.warnings.map((w, i) => (
        <div key={i} role="alert" style={{ display: "flex", gap: 10, padding: "10px 14px", borderTop: "1px solid var(--hairline)", borderLeft: "3px solid var(--hazard)", background: "color-mix(in srgb, var(--hazard) 10%, var(--surface))", fontSize: 12, lineHeight: "17px" }}>
          <Warning size={16} weight="bold" color="var(--hazard)" style={{ flex: "none", marginTop: 1 }} />{w}
        </div>
      ))}
      {s.previewErr && f && <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: "1px solid var(--hairline)", color: "var(--hazard)", fontSize: 12 }}>{s.previewErr}</p>}
    </Card>
  );
}
