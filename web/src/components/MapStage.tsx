// Rev 5 map stage: the globe plus every overlay (compass, view switch, map controls, hover tooltip,
// waypoints, place labels, time-to-flood layer and legend). All styling follows the rev 5 design
// (docs/design/rev5-ref/parts.py): tokens only, no hand-rolled colours.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import * as Cesium from "cesium";
import { ArrowsOut, CaretDown, Crosshair, Drone, GlobeHemisphereWest, RoadHorizon, X } from "@phosphor-icons/react";
import { Globe } from "./Globe";
import { fmtT, ProvenanceBadge } from "./ds";
import { API, getPointSeries, SERIES_DEBOUNCE_MS } from "../lib/api";
import type { AOIManifest, PointSeries, RunManifest } from "../lib/api";
import { useExtras } from "../lib/extras";
import { setFocus, useFocus } from "../lib/focus";
import { EVENT_ICON, SERVER_EVENT } from "./rev5";
import { useLayers } from "../lib/layers";
import { setInspect, setPinnedSeries } from "../lib/inspect";
import { addWaypoint, removeWaypoint, useWaypoints } from "../lib/waypoints";

export type MapStageProps = {
  aoi?: AOIManifest; run?: RunManifest; frames?: { t_s: number; url: string }[]; tS: number;
  ionToken: string; buildingsUrl?: string; runsBase: string;
};

const MAX_PITCH = Cesium.Math.toRadians(-12);
const MIN_PITCH = Cesium.Math.toRadians(-90);
const WET_M = 0.15;
const IMPASSABLE_M = 0.3;
const FIG: CSSProperties = { fontVariantNumeric: "tabular-nums" };
const cssColor = (name: string) =>
  Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim());

type Reading = { depth: number; max: number; ser?: PointSeries | null };
type Place = { name: string; lon: number; lat: number; ring: [number, number][] };
type Area = { road_km_impassable: number; buildings_flooded: number };
type ArrivalLegend = { edges_min: number[]; alphas: number[]; rgb: string; note: string };
type Anchors = Set<(scene: Cesium.Scene) => void>;

// ---------- style fragments from parts.py ----------
const elevHi = "var(--elev-hi, transparent)";
const groupStyle: CSSProperties = {
  display: "flex", alignItems: "center", height: 32, padding: "0 3px",
  background: "color-mix(in srgb, var(--surface-raised) 92%, transparent)", backdropFilter: "blur(6px)",
  border: "1px solid var(--hairline)", borderRadius: 6,
  boxShadow: `inset 0 1px 0 ${elevHi}, var(--shadow-float)`,
};
const pill: CSSProperties = {
  padding: "4px 10px", background: "color-mix(in srgb, var(--ground) 84%, transparent)",
  border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", fontSize: 11, color: "var(--ink-muted)", whiteSpace: "nowrap",
};
const segBtn = (on: boolean, h: number, disabled = false): CSSProperties => ({
  height: h, padding: "0 9px", border: 0, borderRadius: 3, font: "inherit", fontSize: 12,
  ...(on
    ? { background: "var(--pressed-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ground)", fontWeight: 600 }
    : { background: "transparent", color: "var(--ink-muted)" }),
  ...(disabled ? { opacity: 0.45, cursor: "not-allowed" } : {}),
});

// ---------- anchored overlay: follows a lon/lat every frame ----------
function Anchored({ anchors, scene, lon, lat, dx = 0, dy = 0, children }: {
  anchors: React.MutableRefObject<Anchors>; scene?: Cesium.Scene; lon: number; lat: number; dx?: number; dy?: number; children: ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scene) return;
    const scratch = new Cesium.Cartesian2();
    const update = (s: Cesium.Scene) => {
      const node = el.current;
      if (!node || s.isDestroyed()) return;
      const h = s.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat)) ?? 0;
      const win = Cesium.SceneTransforms.worldToWindowCoordinates(s, Cesium.Cartesian3.fromDegrees(lon, lat, h), scratch);
      const w = s.canvas.clientWidth, hh = s.canvas.clientHeight;
      if (!win || win.x < -80 || win.y < -80 || win.x > w + 80 || win.y > hh + 80) { node.style.display = "none"; return; }
      node.style.display = "";
      node.style.transform = `translate(${Math.round(win.x + dx)}px, ${Math.round(win.y + dy)}px)`;
    };
    anchors.current.add(update);
    update(scene);
    return () => { anchors.current.delete(update); };
  }, [scene, lon, lat, dx, dy, anchors]);
  return <div ref={el} style={{ position: "absolute", left: 0, top: 0, display: "none", pointerEvents: "none", willChange: "transform" }}>{children}</div>;
}

// ---------- geometry helpers ----------
function pointInRing(x: number, y: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function labelPoint(ring: [number, number][]): [number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (a !== 0) {
    const c: [number, number] = [cx / (3 * a), cy / (3 * a)];
    if (pointInRing(c[0], c[1], ring)) return c;
  }
  return ring[0];
}
function parsePlaces(data: unknown): Place[] {
  const out: Place[] = [];
  const features = (data as { features?: unknown[] })?.features;
  if (!Array.isArray(features)) return out;
  for (const item of features) {
    const f = item as { properties?: { name?: unknown }; geometry?: { type?: string; coordinates?: any } };
    const name = f.properties?.name;
    const g = f.geometry;
    if (typeof name !== "string" || !g) continue;
    const raw = g.type === "Polygon" ? g.coordinates?.[0] : g.type === "MultiPolygon" ? g.coordinates?.[0]?.[0] : undefined;
    if (!Array.isArray(raw) || raw.length < 3) continue;
    const ring = raw.map((p: number[]) => [p[0], p[1]] as [number, number]);
    if (!ring.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) continue;
    const [lon, lat] = labelPoint(ring);
    out.push({ name, lon, lat, ring });
  }
  return out;
}

async function fetchDepth(runId: string, lon: number, lat: number, tS: number, signal?: AbortSignal): Promise<Reading | null> {
  try {
    const r = await fetch(`${API}/api/runs/${runId}/depth?lon=${lon}&lat=${lat}&t_s=${Math.round(tS)}`, { signal });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.depth_m === "number" ? { depth: d.depth_m, max: d.max_depth_m } : null;
  } catch { return null; }
}

const m2 = (v: number) => `${v.toFixed(2)} m`;

/** Depth now (from the depth endpoint) plus the point's whole series (first wet, first impassable). */
async function fetchReading(runId: string, lon: number, lat: number, tS: number): Promise<Reading | null> {
  const [r, ser] = await Promise.all([fetchDepth(runId, lon, lat, tS), getPointSeries(runId, lon, lat)]);
  return r ? { ...r, ser } : null;
}

// ---------- small presentational pieces ----------
function Compass({ headingDeg, onReset }: { headingDeg: number; onReset: () => void }) {
  const rot = -headingDeg;
  return (
    <button type="button" onClick={onReset} title="Reset to north" aria-label={`North, rotated ${Math.round(rot)} degrees. Click to reset.`}
      style={{ position: "absolute", top: 16, left: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: 0,
        background: "transparent", border: 0, font: "inherit", cursor: "pointer", pointerEvents: "auto" }}>
      <span style={{ fontSize: 10, lineHeight: "12px", fontWeight: 600, color: "var(--ink)", textShadow: "0 0 3px var(--ground)" }}>N</span>
      <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true" style={{ filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.45))" }}>
        <circle cx="18" cy="18" r="17" fill="var(--surface-raised)" stroke="var(--hairline)" />
        <g transform={`rotate(${rot} 18 18)`}>
          <line x1="18" y1="2.5" x2="18" y2="6.5" stroke="var(--ink)" strokeWidth="1.5" />
          {[90, 180, 270].map((a) => <line key={a} x1="18" y1="3.5" x2="18" y2="6.5" stroke="var(--ink-muted)" strokeWidth="1.2" transform={`rotate(${a} 18 18)`} />)}
          <path d="M18 8.5 23 25 18 21.5 13 25z" fill="var(--ink)" />
          <path d="M18 8.5 18 21.5 13 25z" fill="var(--ink-muted)" />
        </g>
      </svg>
    </button>
  );
}

function ViewSwitch({ active, onPick, canFly }: { active: "Orbit" | "Plan" | "Fly along"; onPick: (v: "Orbit" | "Plan") => void; canFly: boolean }) {
  const items = [
    { name: "Orbit" as const, icon: <GlobeHemisphereWest size={14} weight="bold" /> },
    { name: "Plan" as const, icon: <Crosshair size={14} weight="bold" /> },
    { name: "Fly along" as const, icon: <Drone size={14} weight="bold" /> },
  ];
  return (
    <div style={{ position: "absolute", top: 16, right: 16, display: "flex", gap: 2, padding: 3, background: "var(--surface-raised)",
      border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: `inset 0 1px 0 ${elevHi}, var(--shadow-float)`, pointerEvents: "auto" }}>
      {items.map((it) => {
        const fly = it.name === "Fly along";
        const disabled = fly && !canFly;
        return (
          <button key={it.name} type="button" disabled={disabled} title={disabled ? "Draw a route first" : it.name}
            aria-pressed={it.name === active} onClick={() => { if (!fly) onPick(it.name as "Orbit" | "Plan"); }}
            style={{ height: 28, display: "flex", alignItems: "center", gap: 6, padding: "0 9px", border: 0, borderRadius: 3, font: "inherit", fontSize: 12,
              ...(it.name === active
                ? { background: "var(--pressed-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ground)" }
                : { background: "transparent", color: "var(--ink-muted)" }),
              ...(disabled ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}>
            {it.icon}{it.name}
          </button>
        );
      })}
    </div>
  );
}

function ScaleBar({ nice, px }: { nice: number; px: number }) {
  const km = nice >= 1000;
  const f = (n: number) => String(km ? n / 1000 : n);
  const unit = km ? " km" : " m";
  return (
    <div aria-label={`Scale ${f(nice)}${unit}`} style={{ position: "relative", width: px, height: 28, marginRight: 10, color: "var(--ink)", fontSize: 11, ...FIG,
      textShadow: "0 0 3px var(--ground), 0 0 1px var(--ground)" }}>
      <span style={{ position: "absolute", left: 0, top: 0, transform: "translateX(-50%)" }}>0</span>
      <span style={{ position: "absolute", left: "50%", top: 0, transform: "translateX(-50%)" }}>{f(nice / 2)}</span>
      <span style={{ position: "absolute", right: 0, top: 0, transform: "translateX(50%)", whiteSpace: "nowrap" }}>{f(nice)}{unit}</span>
      <svg width={px} height="10" viewBox={`0 0 ${px} 10`} style={{ position: "absolute", left: 0, bottom: 0, overflow: "visible" }} aria-hidden="true">
        <path d={`M1 1v8 M${px - 1} 1v8 M1 6h${px - 2}`} stroke="var(--ground)" strokeWidth="4" strokeLinecap="round" fill="none" />
        <path d={`M1 1v8 M${px - 1} 1v8 M1 6h${px - 2} M${px / 2} 3.5v5 M${px / 4} 4.5v3 M${px * 0.75} 4.5v3`} stroke="var(--ink)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </svg>
    </div>
  );
}

function Tooltip({ r, tS, cellM, pinned, style }: { r: Reading; tS: number; cellM: number; pinned: boolean; style?: CSSProperties }) {
  const ser = r.ser;
  const wetM = ser?.threshold_m.flooded ?? WET_M, passM = ser?.threshold_m.road_impassable ?? IMPASSABLE_M;
  const wet = r.depth >= wetM, cut = r.depth >= passM;
  const permanent = !!ser?.permanent_water;
  const since = (t: number | null | undefined) => (!ser ? "" : t == null ? "never" : `since ${fmtT(t)}`);
  return (
    <div role="tooltip" style={{ width: 236, display: "flex", flexDirection: "column", background: "var(--surface-raised)", border: "1px solid var(--hairline)",
      borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", fontSize: 12, lineHeight: "17px", overflow: "hidden", ...style }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "8px 10px 6px" }}>
        {permanent ? (
          <span style={{ fontSize: 16, lineHeight: "20px", fontWeight: 600 }}>Permanent water</span>
        ) : (
          <>
            <span style={{ fontSize: 16, lineHeight: "20px", fontWeight: 600, color: cut ? "var(--hazard)" : "var(--ink)", ...FIG }}>{m2(r.depth)}</span>
            <span style={{ color: "var(--ink-muted)" }}>at {fmtT(tS)}</span>
            <span style={{ marginLeft: "auto", color: "var(--ink-muted)", ...FIG }}>max {m2(r.max)}</span>
          </>
        )}
      </div>
      {!permanent && (
        <div style={{ display: "grid", gridTemplateColumns: "14px minmax(0, 1fr) auto", columnGap: 6, rowGap: 3, alignItems: "center", padding: "6px 10px 8px",
          borderTop: "1px solid var(--hairline)" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--depth-2)", opacity: wet ? 1 : 0.4 }} />
          <span>Wet, ≥ {wetM.toFixed(2)} m</span><span style={{ color: "var(--ink-muted)", ...FIG }}>{since(ser?.first_flooded_s)}</span>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--hazard)", opacity: cut ? 1 : 0.4 }} />
          <span>Road impassable</span><span style={{ color: "var(--ink-muted)", ...FIG }}>{since(ser?.first_impassable_s)}</span>
        </div>
      )}
      <div style={{ padding: "5px 10px", background: "var(--surface)", borderTop: "1px solid var(--hairline)", color: "var(--ink-muted)", fontSize: 11 }}>
        {pinned ? `Pinned · Esc to clear · ${cellM} m model cell` : `Click to pin · ${cellM} m model cell`}
      </div>
    </div>
  );
}

function WaypointPin({ n, reading, wetFrom, selected, onSelect }: { n: number; reading?: Reading; wetFrom?: string; selected: boolean; onSelect: () => void }) {
  return (
    <div onClick={onSelect} style={{ position: "absolute", left: 0, top: 0, transform: "translate(-50%, -100%)", display: "flex", flexDirection: "column", alignItems: "center",
      pointerEvents: "auto", cursor: "pointer" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 9px 4px 4px", background: "var(--surface-raised)", border: "1px solid var(--danfo)",
        borderRadius: "var(--radius-md)", boxShadow: selected ? "0 0 0 2px var(--danfo), var(--shadow-float)" : "var(--shadow-float)", whiteSpace: "nowrap" }}>
        <span style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--danfo)", color: "var(--on-danfo)",
          borderRadius: 3, fontSize: 11, fontWeight: 700, ...FIG }}>{n}</span>
        <span style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 12, lineHeight: "15px", fontWeight: 600, ...FIG }}>{reading ? `${m2(reading.depth)} now` : "…"}</span>
          <span style={{ fontSize: 11, lineHeight: "14px", color: "var(--ink-muted)", ...FIG }}>{reading ? `max ${m2(reading.max)}` : " "}</span>
          {wetFrom && <span style={{ fontSize: 11, lineHeight: "14px", color: "var(--ink-muted)", ...FIG }}>{wetFrom}</span>}
        </span>
      </span>
      <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true" style={{ marginTop: -1 }}><path d="M1 0h10L6 7z" fill="var(--surface-raised)" stroke="var(--danfo)" /></svg>
      <span style={{ width: 8, height: 8, marginTop: 1, borderRadius: "50%", background: "var(--danfo)", boxShadow: "0 0 0 2px var(--ground)" }} />
    </div>
  );
}

function PlaceLabel({ name, sub, selected, onClick }: { name: string; sub?: string[]; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      style={{ position: "absolute", left: 0, top: 0, transform: "translate(-4px, -50%)", display: "flex", alignItems: "center", gap: 8, padding: 0, background: "transparent",
        border: 0, font: "inherit", color: "var(--ink)", textAlign: "left", cursor: "pointer", pointerEvents: "auto" }}>
      <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: "var(--ink)", boxShadow: "0 0 0 2px var(--ground)" }} />
      <span style={{ display: "flex", flexDirection: "column", padding: "4px 9px 5px", background: "color-mix(in srgb, var(--ground) 84%, transparent)", backdropFilter: "blur(6px)",
        border: selected ? "1px solid var(--danfo)" : "1px solid color-mix(in srgb, var(--ink) 10%, transparent)", borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-float)", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, lineHeight: "16px", fontWeight: 600 }}>{name}</span>
        {sub?.map((l) => <span key={l} style={{ color: "var(--ink-muted)", fontSize: 11, lineHeight: "14px", ...FIG }}>{l}</span>)}
      </span>
    </button>
  );
}

const cardStyle: CSSProperties = {
  display: "flex", flexDirection: "column", padding: "4px 9px 5px", background: "color-mix(in srgb, var(--ground) 84%, transparent)", backdropFilter: "blur(6px)",
  border: "1px solid color-mix(in srgb, var(--ink) 10%, transparent)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", whiteSpace: "nowrap",
};

/** A timestamped event dot with a two-line label (map_label style). */
function EventMarker({ color, name, sub, muted }: { color: string; name: string; sub: string; muted: boolean }) {
  return (
    <div style={{ position: "absolute", left: 0, top: 0, transform: "translate(-4px, -50%)", display: "flex", alignItems: "center", gap: 8, opacity: muted ? 0.45 : 1 }}>
      <span style={{ width: 10, height: 10, flex: "none", borderRadius: "50%", background: color, boxShadow: "0 0 0 2px var(--ground)" }} />
      <span style={cardStyle}>
        <span style={{ fontSize: 12, lineHeight: "16px", fontWeight: 600 }}>{name}</span>
        <span style={{ color: "var(--ink-muted)", fontSize: 11, lineHeight: "14px", ...FIG }}>{sub}</span>
      </span>
    </div>
  );
}

function Sparkline({ points }: { points: [number, number][] }) {
  const W = 60, H = 18;
  if (points.length < 2) return <svg width={W} height={H} aria-hidden="true" />;
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const vmax = Math.max(...points.map((p) => p[1]), 1e-9);
  const d = points.map(([t, v], i) => `${i ? "L" : "M"}${((W * (t - t0)) / Math.max(1, t1 - t0)).toFixed(1)} ${(H - 1.5 - (H - 3) * (v / vmax)).toFixed(1)}`).join(" ");
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" style={{ display: "block" }}><path d={d} fill="none" stroke="var(--depth-3)" strokeWidth="1.5" strokeLinejoin="round" /></svg>;
}

/** River inflow source: name plus a hydrograph sparkline. */
function InflowMarker({ name, hydrograph, units, title }: { name: string; hydrograph: [number, number][]; units: string; title?: string }) {
  return (
    <div title={title} style={{ position: "absolute", left: 0, top: 0, transform: "translate(-4px, -50%)", display: "flex", alignItems: "center", gap: 8, pointerEvents: "auto" }}>
      <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: "var(--depth-3)", boxShadow: "0 0 0 2px var(--ground)" }} />
      <span style={cardStyle}>
        <span style={{ fontSize: 12, lineHeight: "16px", fontWeight: 600 }}>{name}</span>
        <Sparkline points={hydrograph} />
        <span style={{ color: "var(--ink-muted)", fontSize: 11, lineHeight: "14px" }}>{units}</span>
      </span>
    </div>
  );
}

function ArrivalLegendBox({ legend }: { legend: ArrivalLegend }) {
  const e = legend.edges_min;
  const labels = legend.alphas.map((_, i) => i === 0 ? `≤${e[0]} min` : i < e.length ? `${e[i - 1]}–${e[i]}` : `>${e[e.length - 1]}`);
  return (
    <div className="ft-legend" style={{ position: "absolute", left: 16, bottom: "var(--map-arrival-legend-bottom, 188px)", pointerEvents: "auto", boxShadow: "var(--shadow-float)" }}>
      <span className="ft-stat-label">Time to flood</span>
      <div style={{ display: "flex", border: "var(--stroke-hairline) solid var(--hairline)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
        {legend.alphas.map((a, i) => <span key={i} style={{ width: 52, height: 14, background: `color-mix(in srgb, var(--hazard) ${Math.round(a * 100)}%, transparent)` }} />)}
      </div>
      <div className="ft-legend-ticks">{labels.map((l, i) => <span key={i} style={{ width: 52 }}>{l}</span>)}</div>
      <span className="ft-legend-note">Arrival of 0.15 m water (assumption), to the nearest 10-min frame</span>
    </div>
  );
}

// ---------- the stage ----------
export function MapStage({ aoi, run, frames, tS, ionToken, buildingsUrl, runsBase }: MapStageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<Cesium.Viewer>();
  const anchors = useRef<Anchors>(new Set());
  const lay = useLayers();
  const wps = useWaypoints();
  const runId = run?.run_id;
  const tSRef = useRef(tS);
  tSRef.current = tS;
  const scene = viewer && !viewer.isDestroyed() ? viewer.scene : undefined;

  // ----- camera state -----
  const [cam, setCam] = useState({ headingDeg: 0, pitchDeg: -30, zoom: 1, nice: 100, px: 120 });
  const reorient = useCallback((heading?: number, pitch?: number) => {
    if (!viewer || viewer.isDestroyed()) return;
    const c = viewer.camera, s = viewer.scene;
    const h = heading ?? c.heading, p = pitch ?? c.pitch;
    const centre = new Cesium.Cartesian2(s.canvas.clientWidth / 2, s.canvas.clientHeight / 2);
    const target = s.globe.pick(c.getPickRay(centre) as Cesium.Ray, s);
    if (!target) { c.setView({ orientation: { heading: h, pitch: p, roll: 0 } }); return; }
    const range = Cesium.Cartesian3.distance(c.positionWC, target);
    c.lookAt(target, new Cesium.HeadingPitchRange(h, p, range));
    c.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }, [viewer]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const s = viewer.scene, c = viewer.camera;
    let lastCam = 0;
    const onPost = () => {
      if (c.pitch > MAX_PITCH || c.pitch < MIN_PITCH || Math.abs(c.roll) > 1e-3) {
        c.setView({ orientation: { heading: c.heading, pitch: Cesium.Math.clamp(c.pitch, MIN_PITCH, MAX_PITCH), roll: 0 } });
      }
      anchors.current.forEach((f) => f(s));
      const now = performance.now();
      if (now - lastCam < 120) return;
      lastCam = now;
      const w = s.canvas.clientWidth, h = s.canvas.clientHeight;
      const a = s.globe.pick(c.getPickRay(new Cesium.Cartesian2(w / 2 - 60, h - 70)) as Cesium.Ray, s);
      const b = s.globe.pick(c.getPickRay(new Cesium.Cartesian2(w / 2 + 60, h - 70)) as Cesium.Ray, s);
      setCam((prev) => {
        const next = { ...prev, headingDeg: Math.round(Cesium.Math.toDegrees(c.heading) * 10) / 10, pitchDeg: Cesium.Math.toDegrees(c.pitch) };
        if (a && b) {
          const m = Cesium.Cartesian3.distance(a, b);  // metres per 120 px
          const pow = Math.pow(10, Math.floor(Math.log10(m)));
          const nice = [5, 2, 1].map((k) => k * pow).find((v) => v <= m) ?? pow;
          next.nice = nice;
          next.px = Math.round((120 * nice) / m);
          next.zoom = Math.round((540 / m) * 10) / 10;  // 1x = the default 3.5 km framing
        }
        return next.headingDeg === prev.headingDeg && next.pitchDeg === prev.pitchDeg && next.nice === prev.nice && next.px === prev.px && next.zoom === prev.zoom ? prev : next;
      });
    };
    s.postRender.addEventListener(onPost);
    return () => { if (!s.isDestroyed()) s.postRender.removeEventListener(onPost); };
  }, [viewer]);

  const view: "Orbit" | "Plan" = cam.pitchDeg <= -89 ? "Plan" : "Orbit";
  const pickView = (v: "Orbit" | "Plan") => reorient(v === "Plan" ? 0 : undefined, Cesium.Math.toRadians(v === "Plan" ? -90 : -30));

  // ----- hover, pin, waypoints, context menu -----
  const bounds = aoi?.grid.bounds_wgs84;
  const cellM = aoi?.grid.cell_size_m ?? 30;
  const [hover, setHover] = useState<(Reading & { x: number; y: number; lon: number; lat: number }) | null>(null);
  const [pinned, setPinned] = useState<(Reading & { lon: number; lat: number }) | null>(null);
  const [wpReadings, setWpReadings] = useState<Record<number, Reading>>({});
  const [wpSeries, setWpSeries] = useState<Record<number, PointSeries>>({});
  const [selectedWp, setSelectedWp] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; lon: number; lat: number } | null>(null);
  const cursor = useRef<{ x: number; y: number; lon: number; lat: number } | null>(null);
  const over = useRef(false);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const tipEl = useRef<HTMLDivElement>(null);

  const inAoi = useCallback((lon: number, lat: number) =>
    !!bounds && lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3], [bounds]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const canvas = viewer.canvas, s = viewer.scene;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    let down: { x: number; y: number } | null = null;
    const local = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const pick = (x: number, y: number) => {
      const p = s.globe.pick(viewer.camera.getPickRay(new Cesium.Cartesian2(x, y)) as Cesium.Ray, s);
      if (!p) return null;
      const c = Cesium.Cartographic.fromCartesian(p);
      return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
    };
    const process = async () => {
      timer = undefined;
      const cur = cursor.current;
      if (!cur || !runId || pinnedRef.current || !inAoi(cur.lon, cur.lat)) { if (!pinnedRef.current) setHover(null); return; }
      const mine = ++seq;
      const r = await fetchReading(runId, cur.lon, cur.lat, tSRef.current);
      if (mine !== seq || pinnedRef.current) return;
      setHover(r ? { ...r, ...cur } : null);
    };
    const onMove = (e: MouseEvent) => {
      const { x, y } = local(e);
      const p = pick(x, y);
      cursor.current = p ? { x, y, ...p } : null;
      if (tipEl.current) { tipEl.current.style.left = `${x + 16 + 236 > canvas.clientWidth ? x - 16 - 236 : x + 16}px`; tipEl.current.style.top = `${y - 10}px`; }
      if (!timer) timer = setTimeout(process, SERIES_DEBOUNCE_MS);
    };
    const onEnter = () => { over.current = true; };
    const onLeave = () => { over.current = false; seq++; if (!pinnedRef.current) setHover(null); };
    const onDown = (e: MouseEvent) => { down = e.button === 0 ? local(e) : null; setMenu(null); };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || !down) return;
      const { x, y } = local(e);
      const moved = Math.hypot(x - down.x, y - down.y) > 4;
      down = null;
      if (moved) return;
      if (pinnedRef.current) { setPinned(null); return; }
      const h = hoverRef.current;
      if (h) { setPinned({ depth: h.depth, max: h.max, ser: h.ser, lon: h.lon, lat: h.lat }); setHover(null); }
    };
    let rdown: { x: number; y: number } | null = null;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const { x, y } = local(e);
      if (rdown && Math.hypot(x - rdown.x, y - rdown.y) > 4) return;  // it was a right-drag (tilt), not a click
      const p = pick(x, y);
      if (p) setMenu({ x, y, ...p });
    };
    const onRDown = (e: MouseEvent) => { if (e.button === 2) rdown = local(e); };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseenter", onEnter);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mousedown", onRDown);
    canvas.addEventListener("mouseup", onUp);
    canvas.addEventListener("contextmenu", onContext);
    return () => {
      clearTimeout(timer);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseenter", onEnter);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mousedown", onRDown);
      canvas.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("contextmenu", onContext);
    };
  }, [viewer, runId, inAoi]);

  // Refresh hover/pin/waypoint values when the clock moves or the run changes.
  useEffect(() => { setHover(null); setPinned(null); setWpReadings({}); }, [runId]);
  useEffect(() => {
    if (!runId) return;
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      const p = pinnedRef.current;
      if (p) {
        const r = await fetchDepth(runId, p.lon, p.lat, tS, ctl.signal);
        if (r && !ctl.signal.aborted) setPinned((cur) => (cur && cur.lon === p.lon && cur.lat === p.lat ? { ...cur, ...r } : cur));
      }
      const h = hoverRef.current;
      if (h) {
        const r = await fetchDepth(runId, h.lon, h.lat, tS, ctl.signal);
        if (r && !ctl.signal.aborted) setHover((cur) => (cur ? { ...cur, ...r } : cur));
      }
      const entries = await Promise.all(wps.map(async (w) => [w.id, await fetchDepth(runId, w.lon, w.lat, tS, ctl.signal)] as const));
      if (!ctl.signal.aborted) {
        const next: Record<number, Reading> = {};
        for (const [id, r] of entries) if (r) next[id] = r;
        setWpReadings(next);
      }
    }, 200);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [runId, tS, wps]);

  // Whole-run series per waypoint (first wet time); it does not change with the clock.
  useEffect(() => {
    setWpSeries({});
    if (!runId) return;
    let cancelled = false;
    wps.forEach((w) => getPointSeries(runId, w.lon, w.lat).then((ser) => {
      if (ser && !cancelled) setWpSeries((cur) => ({ ...cur, [w.id]: ser }));
    }));
    return () => { cancelled = true; };
  }, [runId, wps]);

  // Inspect store: the pinned point wins over the hover.
  const shown = pinned ?? hover;
  useEffect(() => {
    setInspect(shown ? { lon: shown.lon, lat: shown.lat, depth_m: shown.depth, max_m: shown.max,
      wet_t: shown.ser?.first_flooded_s ?? null, impassable_t: shown.ser?.first_impassable_s ?? null } : null);
  }, [shown?.lon, shown?.lat, shown?.depth, shown?.max, shown?.ser]);
  useEffect(() => () => setInspect(null), []);
  // The pinned point's depth series feeds the dock chart.
  useEffect(() => { setPinnedSeries(pinned?.ser?.depth_m ?? null); }, [pinned?.ser]);
  useEffect(() => () => setPinnedSeries(null), []);

  const dropWaypoint = useCallback((lon: number, lat: number) => {
    if (!inAoi(lon, lat)) return;
    setSelectedWp(addWaypoint(lon, lat).id);
  }, [inAoi]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") { setPinned(null); setMenu(null); setSelectedPlace(null); setSelectedWp(null); }
      else if ((e.key === "w" || e.key === "W") && over.current && cursor.current) { dropWaypoint(cursor.current.lon, cursor.current.lat); }
      else if ((e.key === "Backspace" || e.key === "Delete") && selectedWp !== null) { e.preventDefault(); removeWaypoint(selectedWp); setSelectedWp(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dropWaypoint, selectedWp]);

  // ----- places -----
  const [places, setPlaces] = useState<Place[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);
  const [area, setArea] = useState<Area | null>(null);
  const aoiId = aoi?.aoi_id;
  useEffect(() => {
    setPlaces([]); setSelectedPlace(null);
    if (!aoiId) return;
    let cancelled = false;
    fetch(`${API}/api/aoi/${aoiId}/layer/places`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setPlaces(parsePlaces(d)); }).catch(() => { /* no places layer */ });
    return () => { cancelled = true; };
  }, [aoiId]);
  const place = useMemo(() => places.find((p) => p.name === selectedPlace), [places, selectedPlace]);
  const { events: evJson, boundary, inflows } = useExtras();
  const ev = evJson && evJson.run_id === runId ? evJson : null;
  const evPlace = useMemo(() => new Map((ev?.places ?? []).map((p) => [p.place, p])), [ev]);
  const selEv = place ? evPlace.get(place.name) : undefined;
  useEffect(() => {
    setArea(null);
    if (!runId || !selectedPlace) return;
    let cancelled = false;
    fetch(`${API}/api/runs/${runId}/area?place=${encodeURIComponent(selectedPlace)}`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setArea({ road_km_impassable: d.road_km_impassable, buildings_flooded: d.buildings_flooded }); }).catch(() => { /* card shows no values */ });
    return () => { cancelled = true; };
  }, [runId, selectedPlace]);
  // Outline of the selected place, in danfo.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !place) return;
    const entity = viewer.entities.add({
      polyline: { positions: Cesium.Cartesian3.fromDegreesArray(place.ring.flat()), width: 3, clampToGround: true, material: cssColor("--danfo") },
    });
    return () => { if (!viewer.isDestroyed()) viewer.entities.remove(entity); };
  }, [viewer, place]);

  // ----- time to flood layer -----
  const rectangle = bounds ? Cesium.Rectangle.fromDegrees(...bounds) : undefined;
  const arrivalLayer = useRef<Cesium.ImageryLayer>();
  const [legend, setLegend] = useState<ArrivalLegend | null>(null);
  const arrivalOn = lay.arrival.on;
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !runId || !arrivalOn || !rectangle) return;
    let cancelled = false;
    Cesium.SingleTileImageryProvider.fromUrl(`${API}/api/runs/${runId}/derived/arrival.png`, { rectangle }).then((p) => {
      if (cancelled || viewer.isDestroyed()) return;
      const l = viewer.imageryLayers.addImageryProvider(p);
      l.alpha = layersAlpha.current;
      arrivalLayer.current = l;
    }).catch(() => { /* run not finished or map unavailable */ });
    return () => {
      cancelled = true;
      if (arrivalLayer.current && !viewer.isDestroyed()) viewer.imageryLayers.remove(arrivalLayer.current, true);
      arrivalLayer.current = undefined;
    };
  }, [viewer, runId, arrivalOn, bounds?.join(",")]);
  const layersAlpha = useRef(lay.arrival.opacity);
  layersAlpha.current = lay.arrival.opacity;
  useEffect(() => { if (arrivalLayer.current) arrivalLayer.current.alpha = lay.arrival.opacity; }, [lay.arrival.opacity]);
  useEffect(() => {
    setLegend(null);
    if (!runId || !arrivalOn) return;
    let cancelled = false;
    fetch(`${API}/api/runs/${runId}/derived/arrival.json`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d && Array.isArray(d.edges_min) && Array.isArray(d.alphas)) setLegend(d as ArrivalLegend); }).catch(() => { /* no legend */ });
    return () => { cancelled = true; };
  }, [runId, arrivalOn]);

  // ----- lagoon / sea edge: clamped 2 px line, --depth-1 at 0.9 alpha -----
  const boundaryOn = lay.boundary.on;
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !boundary || !boundaryOn) return;
    const color = cssColor("--depth-1").withAlpha(0.9);
    const made: Cesium.Entity[] = [];
    for (const f of boundary.features) {
      const lines: number[][][] = f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates];
      for (const line of lines) {
        if (!Array.isArray(line) || line.length < 2) continue;
        made.push(viewer.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(line.flatMap((c) => [c[0], c[1]])), width: 2, clampToGround: true, material: color } }));
      }
    }
    return () => { if (!viewer.isDestroyed()) made.forEach((e) => viewer.entities.remove(e)); };
  }, [viewer, boundary, boundaryOn]);

  // ----- fly to a point asked for by the dock -----
  const focusReq = useFocus();
  useEffect(() => {
    if (!focusReq || !viewer || viewer.isDestroyed()) return;
    const c = viewer.camera;
    const h = viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(focusReq.lon, focusReq.lat)) ?? 0;
    c.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(focusReq.lon, focusReq.lat, h), 300),
      { duration: 1, offset: new Cesium.HeadingPitchRange(c.heading, Cesium.Math.clamp(c.pitch, MIN_PITCH, MAX_PITCH), 900) });
    setFocus(null);
  }, [focusReq, viewer]);

  // ----- fullscreen -----
  const fullscreen = () => {
    const node = stage.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen?.();
  };

  const tooltipLeft = (x: number) => (stage.current && x + 16 + 236 > stage.current.clientWidth ? x - 16 - 236 : x + 16);
  const kind = run?.backend === "fake" ? "placeholder" : "simulated";
  const sub = (p: Place) => {
    const e = evPlace.get(p.name);
    const lines: string[] = [];
    if (e) lines.push(e.ten_pct_wet_s != null ? `10 % wet at ${fmtT(e.ten_pct_wet_s)}` : "Never 10 % wet");
    if (selectedPlace === p.name && area) lines.push(`${area.road_km_impassable.toFixed(1)} km impassable`);
    return lines;
  };
  const baseline = !run?.scenario.interventions?.length;

  return (
    <div ref={stage} style={{ position: "relative", width: "100%", height: "100%", minHeight: 0, background: "var(--ground)" }}>
      {aoi && <Globe aoi={aoi} frames={frames} tS={tS} ionToken={ionToken} buildingsUrl={buildingsUrl}
        buildingDepthsUrl={run?.building_depths ? `${runsBase.replace(/\/$/, "")}/${run.run_id}/${run.building_depths}` : undefined}
        onViewer={setViewer} />}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
        {lay.places.on && places.map((p) => {
          const lp = evPlace.get(p.name)?.label_point;
          return (
          <Anchored key={p.name} anchors={anchors} scene={scene} lon={lp?.[0] ?? p.lon} lat={lp?.[1] ?? p.lat}>
            <div style={{ opacity: lay.places.opacity }}>
              <PlaceLabel name={p.name} sub={sub(p)} selected={selectedPlace === p.name} onClick={() => setSelectedPlace(selectedPlace === p.name ? null : p.name)} />
            </div>
          </Anchored>
          );
        })}

        {ev && ev.events.map((e, k) => {
          const m = SERVER_EVENT[e.kind];
          if (!e.point || !m) return null;
          return (
            <Anchored key={`${e.kind}-${k}`} anchors={anchors} scene={scene} lon={e.point[0]} lat={e.point[1]} dy={-22}>
              <EventMarker color={EVENT_ICON[m.kind].color} name={m.label} sub={`${fmtT(e.t_s)}${e.place ? ` · ${e.place}` : ""}`} muted={e.t_s > tS} />
            </Anchored>
          );
        })}

        {inflows?.features.map((f) => (
          <Anchored key={f.properties.name} anchors={anchors} scene={scene} lon={f.geometry.coordinates[0]} lat={f.geometry.coordinates[1]}>
            <InflowMarker name={f.properties.name} hydrograph={f.properties.hydrograph} units={f.properties.units}
              title={/south fork/i.test(f.properties.name) ? inflows.properties?.note : undefined} />
          </Anchored>
        ))}

        {wps.map((w) => (
          <Anchored key={w.id} anchors={anchors} scene={scene} lon={w.lon} lat={w.lat}>
            <WaypointPin n={w.n} reading={wpReadings[w.id]} wetFrom={wpSeries[w.id] ? (wpSeries[w.id].first_flooded_s != null ? `Wet since ${fmtT(wpSeries[w.id].first_flooded_s as number)}` : "Never wet") : undefined} selected={selectedWp === w.id} onSelect={() => setSelectedWp(w.id)} />
          </Anchored>
        ))}

        {pinned && (
          <Anchored anchors={anchors} scene={scene} lon={pinned.lon} lat={pinned.lat} dx={16} dy={-10}>
            <Tooltip r={pinned} tS={tS} cellM={cellM} pinned style={{ pointerEvents: "auto" }} />
          </Anchored>
        )}
        {!pinned && hover && (
          <div ref={tipEl} style={{ position: "absolute", left: tooltipLeft(hover.x), top: hover.y - 10 }}>
            <Tooltip r={hover} tS={tS} cellM={cellM} pinned={false} />
          </div>
        )}

        {menu && (
          <div role="menu" style={{ position: "absolute", left: menu.x, top: menu.y, minWidth: 160, padding: 3, background: "var(--surface-raised)", border: "1px solid var(--hairline)",
            borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", pointerEvents: "auto" }}>
            <button type="button" role="menuitem" onClick={() => { dropWaypoint(menu.lon, menu.lat); setMenu(null); }}
              style={{ width: "100%", height: 28, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 9px", border: 0, borderRadius: 3,
                background: "transparent", color: "var(--ink)", font: "inherit", fontSize: 12, textAlign: "left", cursor: "pointer" }}>
              Drop waypoint<span style={{ color: "var(--ink-muted)" }}>W</span>
            </button>
          </div>
        )}

        <Compass headingDeg={cam.headingDeg} onReset={() => reorient(0)} />
        {run && !!frames?.length && (
          <div style={{ position: "absolute", top: 30, left: 64, pointerEvents: "auto" }}>
            <ProvenanceBadge kind={kind}>{`${kind === "placeholder" ? "Placeholder physics" : "Simulated"} · ${fmtT(tS)}`}</ProvenanceBadge>
          </div>
        )}
        <ViewSwitch active={view} onPick={pickView} canFly={false} />
        <span style={{ ...pill, position: "absolute", left: "50%", top: 18, transform: "translateX(-50%)" }}>
          Drag to orbit · right-drag to tilt · scroll to zoom · W to drop a waypoint
        </span>

        {legend && arrivalOn && <ArrivalLegendBox legend={legend} />}

        {place && (
          <div style={{ position: "absolute", left: "50%", bottom: 74, transform: "translateX(-50%)", display: "flex", flexDirection: "column", minWidth: 520, background: "var(--surface-raised)",
            border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", whiteSpace: "nowrap", overflow: "hidden", pointerEvents: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, height: 36, padding: "0 8px 0 12px", borderBottom: "1px solid var(--hairline)" }}>
              <RoadHorizon size={15} weight="fill" color="var(--hazard)" style={{ flex: "none" }} />
              <span style={{ fontWeight: 600 }}>{place.name}</span>
              <span style={{ color: "var(--ink-muted)" }}>· corridor, {baseline ? "baseline " : ""}run maximum</span>
              <button type="button" aria-label="Close" onClick={() => setSelectedPlace(null)}
                style={{ marginLeft: "auto", width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, background: "transparent", border: 0, color: "var(--ink-muted)", cursor: "pointer" }}>
                <X size={14} weight="bold" />
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "auto auto minmax(0, 1fr)", alignItems: "center", background: "var(--surface)" }}>
              <div style={{ display: "flex", flexDirection: "column", padding: "8px 16px 9px 12px" }}>
                <span style={{ fontSize: 20, lineHeight: "24px", fontWeight: 700, color: "var(--hazard)", ...FIG }}>{area ? `${area.road_km_impassable.toFixed(1)} km` : "…"}</span>
                <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>impassable</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", padding: "8px 16px 9px", borderLeft: "1px solid var(--hairline)" }}>
                <span style={{ fontSize: 20, lineHeight: "24px", fontWeight: 700, ...FIG }}>{area ? area.buildings_flooded.toLocaleString() : "…"}</span>
                <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>buildings flooded</span>
              </div>
              {selEv && (
                <div style={{ display: "flex", flexDirection: "column", padding: "8px 16px 9px", borderLeft: "1px solid var(--hairline)" }}>
                  <span style={{ fontSize: 20, lineHeight: "24px", fontWeight: 700, ...FIG }}>{selEv.first_road_cut_s != null ? fmtT(selEv.first_road_cut_s) : "None"}</span>
                  <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>first cut on it</span>
                </div>
              )}
              <span />
            </div>
          </div>
        )}

        <div style={{ position: "absolute", right: 16, bottom: 26, display: "flex", alignItems: "flex-end", gap: 8, pointerEvents: "auto" }}>
          <ScaleBar nice={cam.nice} px={cam.px} />
          <div style={{ ...groupStyle, gap: 2 }}>
            <button type="button" aria-pressed={view === "Plan"} onClick={() => pickView("Plan")} style={segBtn(view === "Plan", 24)}>2D</button>
            <button type="button" aria-pressed={view === "Orbit"} onClick={() => pickView("Orbit")} style={segBtn(view === "Orbit", 24)}>3D</button>
          </div>
          <div style={{ ...groupStyle, padding: "0 8px 0 10px", gap: 6, fontSize: 12, ...FIG }} aria-label="Zoom">{cam.zoom.toFixed(1)}×<CaretDown size={12} weight="bold" color="var(--ink-muted)" /></div>
          <button type="button" aria-label="Fullscreen" title="Fullscreen" onClick={fullscreen}
            style={{ ...groupStyle, width: 32, padding: 0, justifyContent: "center", color: "var(--ink)", font: "inherit", cursor: "pointer" }}>
            <ArrowsOut size={15} weight="bold" />
          </button>
        </div>
      </div>
    </div>
  );
}
