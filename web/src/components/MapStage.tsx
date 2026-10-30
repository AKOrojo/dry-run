// Rev 5 map stage: the globe plus every overlay (compass, view switch, map controls, hover tooltip,
// waypoints, place labels, time-to-flood layer and legend). All styling follows the rev 5 design
// (docs/design/rev5-ref/parts.py): tokens only, no hand-rolled colours.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import * as Cesium from "cesium";
import { ArrowsOut, ArrowsOutCardinal, CaretDown, Crosshair, Drone, GlobeHemisphereWest, Pause, Path, Play, RoadHorizon, X } from "@phosphor-icons/react";
import { Globe } from "./Globe";
import { fmtT, ProvenanceBadge } from "./ds";
import { API, getBuildingDepths, getPointInfo, getPointSeries, SERIES_DEBOUNCE_MS } from "../lib/api";
import type { AOIManifest, PointInfo, PointSeries, RunManifest } from "../lib/api";
import { useExtras } from "../lib/extras";
import { setFocus, useFocus } from "../lib/focus";
import { EVENT_ICON, SERVER_EVENT, serverEventLabel } from "./rev5";
import { useLayers } from "../lib/layers";
import { setInspect, setPinnedSeries } from "../lib/inspect";
import { addWaypoint, removeWaypoint, setWaypointInfo, useWaypoints } from "../lib/waypoints";
import type { WaypointInfo } from "../lib/waypoints";
import { placeLabel, WaypointDetails } from "./WaypointDetails";
import { setMapViewer, useView } from "../lib/view";
import { clearFlyRoute, setFlyRoute, useEvacLine, useFlyRoute } from "../lib/flyroute";
import type { LonLat } from "../lib/flyroute";
import { useFlyAlong, useFreeCamera } from "./camera";
import { FLY_SPEEDS, routeLength } from "./camera";
import type { FlyHud, FlySpeed } from "./camera";
import { clock } from "../lib/clock";
import { rain as rainStore, setRain, useRain } from "../lib/rain";
import { RainMap } from "./RainMap";
import { FlowHazardMap, FlowLegend } from "./FlowHazard";
import { DrainsLegend, DrainsMap } from "./Drainage";
import { flowStore } from "../lib/flowhazard";
import { Anchored } from "./Anchored";
import { CloudsRain } from "./CloudsRain";
import { CoordChip } from "./CoordChip";
import { useSim } from "../lib/simstate";
import { useWeatherSource } from "../lib/weather";
import { CloseUpMap } from "./CloseUp";
import { GpuBoxMap } from "./GpuBoxMap";
import { DomainMap, domainBbox, outsideDomain } from "./DomainMap";
import { useCloseUp } from "../lib/patch3d";
import type { Anchors } from "./Anchored";

type CamMode = "orbit" | "free" | "fly";
type ViewName = "Orbit" | "Free" | "Plan" | "Fly along";

export type MapStageProps = {
  /** The storm being edited: the rain-area overlay draws its label and track from it. */
  rainStorm?: { total_mm: number; duration_h: number; pattern?: "uniform" | "front_loaded" | "center_peaked" };
  aoi?: AOIManifest; run?: RunManifest; frames?: { t_s: number; url: string }[]; tS: number;
  ionToken: string; buildingsUrl?: string; runsBase: string;
  /** Compare swipe: run B's frames, drawn right of `split` (0..1 of the width) while `frames` stay left of it. */
  framesB?: { t_s: number; url: string }[]; split?: number;
  /** Also told about the Cesium viewer (Compare's side-by-side map follows its camera). */
  onViewer?: (viewer: Cesium.Viewer | undefined) => void;
  /** Plan view: a click on a building selects it (shift: as the second one) instead of pinning a point. */
  onBuilding?: (id: string, shift: boolean) => void;
  /** Told when the camera switches between Orbit and Plan. */
  onView?: (view: "Orbit" | "Plan") => void;
  /** Drawn on the map under every label, card and popup (Plan view's graticule). */
  underlay?: ReactNode;
};

const MAX_PITCH = Cesium.Math.toRadians(-12);
const MIN_PITCH = Cesium.Math.toRadians(-90);
const WET_M = 0.15;
const IMPASSABLE_M = 0.3;
const FIG: CSSProperties = { fontVariantNumeric: "tabular-nums" };
const cssColor = (name: string) =>
  Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim());

type Reading = { depth: number; max: number; ser?: PointSeries | null; loading?: boolean };
type Place = { name: string; lon: number; lat: number; ring: [number, number][] };
type Area = { road_km_impassable: number; buildings_flooded: number };
type ArrivalLegend = { edges_min: number[]; alphas: number[]; rgb: string; note: string };

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

function ViewSwitch({ active, onPick, canFly }: { active: ViewName; onPick: (v: ViewName) => void; canFly: boolean }) {
  const items = [
    { name: "Orbit" as const, icon: <GlobeHemisphereWest size={14} weight="bold" /> },
    { name: "Free" as const, icon: <ArrowsOutCardinal size={14} weight="bold" /> },
    { name: "Plan" as const, icon: <Crosshair size={14} weight="bold" /> },
    { name: "Fly along" as const, icon: <Drone size={14} weight="bold" /> },
  ];
  return (
    <div data-tour="camera" style={{ display: "flex", gap: 2, padding: 3, background: "var(--surface-raised)",
      border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: `inset 0 1px 0 ${elevHi}, var(--shadow-float)`, pointerEvents: "auto" }}>
      {items.map((it) => {
        const disabled = it.name === "Fly along" && !canFly;
        return (
          <button key={it.name} type="button" disabled={disabled} title={disabled ? "Draw a route first" : it.name}
            aria-pressed={it.name === active} onClick={() => onPick(it.name)}
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

const menuItem: CSSProperties = {
  width: "100%", height: 28, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 9px", border: 0, borderRadius: 3,
  background: "transparent", color: "var(--ink)", font: "inherit", fontSize: 12, textAlign: "left", cursor: "pointer",
};

/** "Draw route" button beside the view switch; with a saved or evacuation route it opens a small menu. */
function RouteButton({ drawing, menuOpen, hasRoute, hasEvac, onDraw, onCancel, onToggleMenu, onEvac, onClear }: {
  drawing: boolean; menuOpen: boolean; hasRoute: boolean; hasEvac: boolean;
  onDraw: () => void; onCancel: () => void; onToggleMenu: () => void; onEvac: () => void; onClear: () => void;
}) {
  const extras = hasRoute || hasEvac;
  return (
    <div style={{ position: "relative", pointerEvents: "auto" }}>
      <div style={{ display: "flex", padding: 3, background: "var(--surface-raised)", border: "1px solid var(--hairline)", borderRadius: 6,
        boxShadow: `inset 0 1px 0 ${elevHi}, var(--shadow-float)` }}>
        <button type="button" aria-pressed={drawing} aria-haspopup={extras ? "menu" : undefined} aria-expanded={extras ? menuOpen : undefined}
          title={drawing ? "Cancel drawing" : "Draw route"} onClick={drawing ? onCancel : extras ? onToggleMenu : onDraw}
          style={{ ...segBtn(drawing, 28), display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <Path size={14} weight="bold" />{drawing ? "Drawing" : "Draw route"}{extras && !drawing && <CaretDown size={11} weight="bold" />}
        </button>
      </div>
      {menuOpen && !drawing && (
        <div role="menu" style={{ position: "absolute", right: 0, top: 40, minWidth: 190, padding: 3, background: "var(--surface-raised)", border: "1px solid var(--hairline)",
          borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)" }}>
          <button type="button" role="menuitem" onClick={onDraw} style={menuItem}>Draw new route</button>
          {hasEvac && <button type="button" role="menuitem" onClick={onEvac} style={menuItem}>Use evacuation route</button>}
          {hasRoute && <button type="button" role="menuitem" onClick={onClear} style={menuItem}>Clear route</button>}
        </div>
      )}
    </div>
  );
}

const fmtLen = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

export type FloodLink = "hold" | "play" | "span";
const LINKS: { key: FloodLink; label: string; title: string }[] = [
  { key: "hold", label: "Hold", title: "Water stays at the timeline's current time" },
  { key: "play", label: "Play with flight", title: "The flood timeline plays while you fly and pauses with the flight" },
  { key: "span", label: "Across route", title: "The whole run is spread over the route: start of the route = T+00:00, end = end of the run" },
];
const SPEED_NAME: Record<FlySpeed, string> = { 30: "Slow", 60: "Normal", 120: "Fast" };
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const primaryBtn: CSSProperties = {
  height: 28, padding: "0 12px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", font: "inherit", fontWeight: 600,
  background: "linear-gradient(180deg, color-mix(in srgb, var(--danfo) 88%, white) 0%, var(--danfo) 100%)", color: "var(--on-danfo)",
  border: "1px solid var(--danfo-edge)", borderRadius: "var(--radius-md)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 1px 2px var(--elev-drop), 0 2px 6px var(--elev-drop-soft)",
};
const textBtn: CSSProperties = { height: 28, padding: "0 8px", background: "transparent", border: 0, color: "var(--ink-muted)", font: "inherit", cursor: "pointer" };
const hudShell: CSSProperties = {
  position: "absolute", left: "50%", bottom: 64, transform: "translateX(-50%)", display: "flex", flexDirection: "column", width: 640,
  background: "var(--surface-raised)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)",
  whiteSpace: "nowrap", overflow: "hidden", pointerEvents: "auto",
};

function waterBelow(ser: PointSeries, tS: number): string {
  if (ser.permanent_water) return "Lagoon / open water below";
  let i = 0;
  ser.t_s.forEach((t, k) => { if (Math.abs(t - tS) < Math.abs(ser.t_s[i] - tS)) i = k; });
  const d = ser.depth_m[i] ?? 0;
  return d >= 0.05 ? `${d.toFixed(2)} m of water below` : "Dry below";
}

/** Shown once a route is drawn: how long it is, and the way into fly along. */
function RouteReadyCard({ len, speed, onFly, onRedraw, onClear, onClose }: { len: number; speed: FlySpeed; onFly: () => void; onRedraw: () => void; onClear: () => void; onClose: () => void }) {
  return (
    <div role="dialog" aria-label="Route ready" style={{ ...hudShell, width: 440 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 6px 0 12px", borderBottom: "1px solid var(--hairline)" }}>
        <Path size={15} weight="bold" color="var(--danfo)" style={{ flex: "none" }} />
        <span style={{ fontWeight: 600 }}>Route ready</span>
        <span style={{ color: "var(--ink-muted)", fontSize: 12, ...FIG }}>{fmtLen(len)} · about {fmtDur(len / speed)} at {SPEED_NAME[speed].toLowerCase()} speed</span>
        <button type="button" aria-label="Close" onClick={onClose} style={{ ...textBtn, marginLeft: "auto", width: 26, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><X size={13} weight="bold" /></button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--surface)" }}>
        <span style={{ fontSize: 12, color: "var(--ink-muted)", whiteSpace: "normal" }}>The camera flies the route 300 m up. Works before, during and after a simulation.</span>
        <button type="button" onClick={onRedraw} style={textBtn}>Redraw</button>
        <button type="button" onClick={onClear} style={textBtn}>Clear</button>
        <button type="button" onClick={onFly} style={primaryBtn}><Drone size={14} weight="bold" />Fly along</button>
      </div>
    </div>
  );
}

function FlyHudCard({ hud, cellM, link, canLink, status, below, onPlay, onSpeed, onSeek, onLink, onExit }: {
  hud: FlyHud; cellM: number; link: FloodLink; canLink: boolean; status: string; below: string | null;
  onPlay: (on: boolean) => void; onSpeed: (n: FlySpeed) => void; onSeek: (s: number) => void; onLink: (l: FloodLink) => void; onExit: () => void;
}) {
  const left = Math.max(0, hud.len - hud.s) / hud.speed;
  return (
    <div role="region" aria-label="Fly along" style={hudShell}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 6px 0 12px", borderBottom: "1px solid var(--hairline)" }}>
        <Drone size={15} weight="bold" color="var(--danfo)" style={{ flex: "none" }} />
        <span style={{ fontWeight: 600 }}>Fly along</span>
        <span style={{ color: "var(--ink-muted)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{status}</span>
        <span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 11 }}>{cellM} m model cells</span>
        <button type="button" aria-label="Exit fly along" title="Exit (Esc)" onClick={onExit} style={{ ...textBtn, width: 26, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><X size={13} weight="bold" /></button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--surface)" }}>
        <button type="button" aria-label={hud.playing ? "Pause" : "Play"} title={hud.playing ? "Pause (Space)" : "Play (Space)"} onClick={() => onPlay(!hud.playing)}
          style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, border: 0, borderRadius: 3, cursor: "pointer",
            background: "var(--pressed-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ground)" }}>
          {hud.playing ? <Pause size={14} weight="bold" /> : <Play size={14} weight="bold" />}
        </button>
        <input type="range" aria-label="Route progress" min={0} max={Math.max(1, Math.round(hud.len))} value={Math.round(hud.s)}
          onChange={(e) => onSeek(Number(e.target.value))} style={{ flex: 1, minWidth: 0, accentColor: "var(--danfo)" }} />
        <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{fmtLen(hud.s)} / {fmtLen(hud.len)} · {fmtDur(left)} left</span>
        <span style={{ fontSize: 12, ...FIG }} title="Height above ground (scroll or E / Q)">{Math.round(hud.hAgl)} m up</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 12px 8px", background: "var(--surface)", fontSize: 12, color: "var(--ink-muted)" }}>
        Speed
        <div style={{ ...groupStyle, height: 26, gap: 2 }}>
          {FLY_SPEEDS.map((n) => <button key={n} type="button" aria-pressed={hud.speed === n} title={`${n} m/s, ${Math.round(n * 3.6)} km/h`} onClick={() => onSpeed(n)} style={{ ...segBtn(hud.speed === n, 20), cursor: "pointer" }}>{SPEED_NAME[n]}</button>)}
        </div>
        Flood
        <div style={{ ...groupStyle, height: 26, gap: 2, opacity: canLink ? 1 : 0.45 }} title={canLink ? undefined : "Run a simulation to link the flood timeline to the flight"}>
          {LINKS.map((l) => <button key={l.key} type="button" disabled={!canLink} aria-pressed={link === l.key} title={l.title} onClick={() => onLink(l.key)} style={{ ...segBtn(link === l.key, 20), cursor: canLink ? "pointer" : "default" }}>{l.label}</button>)}
        </div>
        {below && <span style={{ marginLeft: "auto", color: "var(--ink)", ...FIG }}>{below}</span>}
      </div>
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

function Tooltip({ r, tS, cellM, pinned, outside, style }: { r: Reading; tS: number; cellM: number; pinned: boolean; outside?: boolean; style?: CSSProperties }) {
  const ser = r.ser;
  const wetM = ser?.threshold_m.flooded ?? WET_M, passM = ser?.threshold_m.road_impassable ?? IMPASSABLE_M;
  const wet = r.depth >= wetM, cut = r.depth >= passM;
  const permanent = !!ser?.permanent_water;
  const since = (t: number | null | undefined) => (!ser ? "" : t == null ? "never" : `since ${fmtT(t)}`);
  if (outside) return (
    <div data-declutter-block role="tooltip" style={{ width: 236, padding: "10px 12px", background: "var(--surface-raised)", border: "1px solid var(--hairline)",
      borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", fontSize: 12, lineHeight: "17px", color: "var(--ink-muted)", ...style }}>
      Outside the simulated area
    </div>
  );
  if (r.loading) return (
    <div data-declutter-block role="tooltip" aria-busy="true" style={{ width: 236, padding: "10px 12px", background: "var(--surface-raised)", border: "1px solid var(--hairline)",
      borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", fontSize: 12, lineHeight: "17px", color: "var(--ink-muted)", ...style }}>
      Loading depth… the first point on a run can take a few seconds.
    </div>
  );
  return (
    <div data-declutter-block role="tooltip" style={{ width: 236, display: "flex", flexDirection: "column", background: "var(--surface-raised)", border: "1px solid var(--hairline)",
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

/** Compact pin (depth now and place); selected, it opens the full description and an X to remove it. */
function WaypointPin({ n, lon, lat, info, selected, onSelect, onRemove }: {
  n: number; lon: number; lat: number; info?: WaypointInfo; selected: boolean; onSelect: () => void; onRemove: () => void;
}) {
  const place = placeLabel(info);
  const main = info?.hasRun ? (info.depth_m != null ? `${m2(info.depth_m)} now` : "…") : place ?? "Waypoint";
  const sub = info?.hasRun ? place : null;
  return (
    <div onClick={onSelect} style={{ position: "absolute", left: 0, top: 0, transform: "translate(-50%, -100%)", display: "flex", flexDirection: "column", alignItems: "center",
      pointerEvents: "auto", cursor: "pointer" }}>
      <span style={{ position: "relative", display: "flex", flexDirection: "column", background: "var(--surface-raised)", border: "1px solid var(--danfo)",
        borderRadius: "var(--radius-md)", boxShadow: selected ? "0 0 0 2px var(--danfo), var(--shadow-float)" : "var(--shadow-float)", whiteSpace: "nowrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 9px 4px 4px" }}>
          <span style={{ width: 20, height: 20, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--danfo)", color: "var(--on-danfo)",
            borderRadius: 3, fontSize: 11, fontWeight: 700, ...FIG }}>{n}</span>
          <span style={{ display: "flex", flexDirection: "column", maxWidth: 200 }}>
            <span style={{ fontSize: 12, lineHeight: "15px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", ...FIG }}>{main}</span>
            {sub && <span style={{ fontSize: 11, lineHeight: "14px", color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</span>}
          </span>
        </span>
        {selected && (
          <span style={{ width: 268, padding: "6px 10px 8px", borderTop: "1px solid var(--hairline)", cursor: "default" }} onClick={(e) => e.stopPropagation()}>
            <WaypointDetails lon={lon} lat={lat} info={info} />
          </span>
        )}
        {selected && (
          <button type="button" aria-label={`Remove waypoint ${n}`} title="Remove waypoint (Delete)" onClick={(e) => { e.stopPropagation(); onRemove(); }}
            style={{ position: "absolute", top: -9, right: -9, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
              background: "var(--surface-raised)", border: "1px solid var(--danfo)", borderRadius: "50%", color: "var(--ink)", boxShadow: "var(--shadow-float)", cursor: "pointer" }}>
            <X size={10} weight="bold" />
          </button>
        )}
      </span>
      <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true" style={{ marginTop: -1 }}><path d="M1 0h10L6 7z" fill="var(--surface-raised)" stroke="var(--danfo)" /></svg>
      <span style={{ width: 8, height: 8, marginTop: 1, borderRadius: "50%", background: "var(--danfo)", boxShadow: "0 0 0 2px var(--ground)" }} />
    </div>
  );
}

function PlaceLabel({ name, sub, selected, onClick }: { name: string; sub?: string[]; selected: boolean; onClick: () => void }) {
  return (
    // Only the chip takes clicks: the dot and the gap stay click-through, so a building under them can be picked.
    <button type="button" onClick={onClick} aria-pressed={selected}
      style={{ position: "absolute", left: 0, top: 0, transform: "translate(-4px, -50%)", display: "flex", alignItems: "center", gap: 8, padding: 0, background: "transparent",
        border: 0, font: "inherit", color: "var(--ink)", textAlign: "left", cursor: "pointer", pointerEvents: "none" }}>
      <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: "var(--ink)", boxShadow: "0 0 0 2px var(--ground)" }} />
      <span style={{ display: "flex", flexDirection: "column", padding: "4px 9px 5px", background: "color-mix(in srgb, var(--ground) 84%, transparent)", backdropFilter: "blur(6px)",
        border: selected ? "1px solid var(--danfo)" : "1px solid color-mix(in srgb, var(--ink) 10%, transparent)", borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-float)", whiteSpace: "nowrap", pointerEvents: "auto" }} data-declutter={selected ? 5 : 1}>
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
      <span style={cardStyle} data-declutter={muted ? 2 : 3}>
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
      <span style={cardStyle} data-declutter={4}>
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
    <div className="ft-legend" style={{ pointerEvents: "auto", boxShadow: "var(--shadow-float)" }}>
      <span className="ft-stat-label">Time to flood</span>
      <div style={{ display: "flex", border: "var(--stroke-hairline) solid var(--hairline)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
        {legend.alphas.map((a, i) => <span key={i} style={{ width: 52, height: 14, background: `color-mix(in srgb, var(--hazard) ${Math.round(a * 100)}%, transparent)` }} />)}
      </div>
      <div className="ft-legend-ticks">{labels.map((l, i) => <span key={i} style={{ width: 52 }}>{l}</span>)}</div>
      <span className="ft-legend-note">Arrival of 0.15 m water (assumption), to the nearest 10-min frame</span>
    </div>
  );
}

/** Labels that overlap give way by priority (data-declutter, higher wins: selected place, river inflows, key events,
 *  then places). The hidden card keeps its dot, so the spot stays marked. Runs every frame after the anchors move. */
function declutter(root: HTMLElement) {
  const boxes = Array.from(root.querySelectorAll<HTMLElement>("[data-declutter]"))
    .map((el) => ({ el, p: Number(el.dataset.declutter) || 0, r: el.getBoundingClientRect() }))
    .filter((b) => b.r.width > 0)
    .sort((a, b) => b.p - a.p);
  // Map controls and the hint pill are obstacles: labels never sit under them.
  const kept: DOMRect[] = Array.from(root.querySelectorAll<HTMLElement>("[data-declutter-block]")).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
  const PAD = 3;
  for (const b of boxes) {
    const hit = kept.some((k) => b.r.left < k.right + PAD && b.r.right > k.left - PAD && b.r.top < k.bottom + PAD && b.r.bottom > k.top - PAD);
    b.el.style.visibility = hit ? "hidden" : "";
    if (!hit) kept.push(b.r);
  }
}

// ---------- the stage ----------
export function MapStage({ rainStorm, aoi, run, frames, framesB, split, onViewer, onBuilding, onView, underlay, tS, ionToken, buildingsUrl, runsBase }: MapStageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<Cesium.Viewer>();
  const anchors = useRef<Anchors>(new Set());
  const lay = useLayers();
  const wps = useWaypoints();
  const rs = useRain();
  const simNow = useSim();
  const weather = useWeatherSource(run);
  const viewState = useView();
  const closeUp = useCloseUp();
  const runId = run?.run_id;
  const tSRef = useRef(tS);
  tSRef.current = tS;
  const scene = viewer && !viewer.isDestroyed() ? viewer.scene : undefined;

  // ----- camera mode (orbit / free / fly along) -----
  const [mode, setMode] = useState<CamMode>("orbit");
  const modeRef = useRef<CamMode>("orbit");
  modeRef.current = mode;
  const [freeSpeed, setFreeSpeed] = useState(1);
  const route = useFlyRoute();
  const evac = useEvacLine();
  const [drawing, setDrawing] = useState(false);
  const [drawPts, setDrawPts] = useState<LonLat[]>([]);
  const drawRef = useRef({ drawing: false, pts: [] as LonLat[] });
  drawRef.current = { drawing, pts: drawPts };
  const [routeMenu, setRouteMenu] = useState(false);
  const fly = useFlyAlong(viewer, mode === "fly", route);
  const flyPlayingRef = useRef(false);
  flyPlayingRef.current = mode === "fly" && fly.hud.playing;
  // Fly along and the flood clock: Hold leaves the timeline alone, Play with flight plays and pauses it with the
  // flight, Across route maps route progress onto the whole run. Before a run (or while one computes) only Hold applies.
  const [routeReady, setRouteReady] = useState(false);
  const pendingPlay = useRef(false);
  useEffect(() => {  // entering fly along from the route card or the view switch starts the flight
    if (mode === "fly" && pendingPlay.current) { pendingPlay.current = false; flyPlay(true); }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {  // Space plays and pauses the flight
    if (mode !== "fly") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== " " || (t && /INPUT|TEXTAREA|SELECT|BUTTON/.test(t.tagName))) return;
      e.preventDefault(); flyPlay(!fly.hud.playing);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const [link, setLink] = useState<FloodLink>("hold");
  const runDone = run?.status === "done" && !!frames?.length;
  const effLink: FloodLink = runDone ? link : "hold";
  const flyPlay = (on: boolean) => {
    fly.play(on);
    if (effLink === "play") clock.set({ playing: on });
  };
  useEffect(() => {  // the flight reached the end (or was left): stop a linked timeline with it
    if (!fly.hud.playing && effLink === "play") clock.set({ playing: false });
  }, [fly.hud.playing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (mode !== "fly" || effLink !== "span" || fly.hud.len <= 0) return;
    clock.set({ playing: false, t_s: (fly.hud.s / fly.hud.len) * clock.get().max_s });
  }, [mode, effLink, fly.hud.s, fly.hud.len]);
  // Water below the camera: the point series at the camera's ground position, refetched every ~60 m.
  const [belowSeries, setBelowSeries] = useState<PointSeries | null>(null);
  const belowAt = useRef<LonLat | null>(null);
  useEffect(() => {
    if (mode !== "fly" || !runDone || !run) { setBelowSeries(null); belowAt.current = null; return; }
    const [lon, lat] = fly.hud.at, prev = belowAt.current;
    if (prev && Math.hypot((lon - prev[0]) * 111320 * Math.cos((lat * Math.PI) / 180), (lat - prev[1]) * 110540) < 60) return;
    belowAt.current = [lon, lat];
    let live = true;
    getPointSeries(run.run_id, lon, lat).then((ser) => { if (live) setBelowSeries(ser); }).catch(() => {});
    return () => { live = false; };
  }, [mode, runDone, run, fly.hud.at]);
  useFreeCamera(viewer, mode === "free", setFreeSpeed);

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
      if (modeRef.current === "orbit" && (c.pitch > MAX_PITCH || c.pitch < MIN_PITCH || Math.abs(c.roll) > 1e-3)) {
        c.setView({ orientation: { heading: c.heading, pitch: Cesium.Math.clamp(c.pitch, MIN_PITCH, MAX_PITCH), roll: 0 } });
      }
      anchors.current.forEach((f) => f(s));
      if (stage.current) declutter(stage.current);
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
  const viewRef = useRef(view);
  viewRef.current = view;
  const onBuildingRef = useRef(onBuilding);
  onBuildingRef.current = onBuilding;
  useEffect(() => { onView?.(view); }, [view]);
  const pickView = (v: "Orbit" | "Plan") => reorient(v === "Plan" ? 0 : undefined, Cesium.Math.toRadians(v === "Plan" ? -90 : -30));
  const active: ViewName = mode === "free" ? "Free" : mode === "fly" ? "Fly along" : view;
  const backToOrbit = useCallback(() => {
    if (modeRef.current === "orbit" || !viewer || viewer.isDestroyed()) return;
    // Leave the low first-person / fly camera at a sensible orbit framing.
    const c = viewer.camera, carto = Cesium.Cartographic.fromCartesian(c.positionWC);
    const g = viewer.scene.globe.getHeight(carto) ?? 0;
    modeRef.current = "orbit";
    setMode("orbit");
    c.setView({ destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, Math.max(carto.height, g + 400)),
      orientation: { heading: c.heading, pitch: Cesium.Math.toRadians(-35), roll: 0 } });
  }, [viewer]);
  // Opening a 3D close-up ends Free / Fly along first, so the close-up's own camera flight is not fought by them.
  useLayoutEffect(() => {
    if (closeUp.active && modeRef.current !== "orbit") { modeRef.current = "orbit"; setMode("orbit"); }
  }, [closeUp.active]);

  // ----- hover, pin, waypoints, context menu -----
  const bounds = aoi?.grid.bounds_wgs84;
  const cellM = Math.round(aoi?.grid.cell_size_m ?? 30);
  const [hover, setHover] = useState<(Reading & { x: number; y: number; lon: number; lat: number }) | null>(null);
  const [pinned, setPinned] = useState<(Reading & { lon: number; lat: number }) | null>(null);
  const [wpReadings, setWpReadings] = useState<Record<number, Reading>>({});
  const [wpSeries, setWpSeries] = useState<Record<number, PointSeries | null>>({});
  const [wpPoint, setWpPoint] = useState<Record<string, PointInfo | null>>({});
  const [bDepths, setBDepths] = useState<Map<string, number> | null>(null);
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
    const hoverAllowed = () => !flowStore.get().drawing && modeRef.current !== "free" && !flyPlayingRef.current && !drawRef.current.drawing && !rainStore.get().picking;
    const process = async () => {
      timer = undefined;
      const cur = cursor.current;
      if (!cur || !runId || pinnedRef.current || !hoverAllowed() || !inAoi(cur.lon, cur.lat)) { if (!pinnedRef.current) setHover(null); return; }
      const mine = ++seq;
      // A cold server instance can take ~20 s to load a run's depth stack: show a loading state, never a timeout.
      const slow = setTimeout(() => { if (mine === seq && !pinnedRef.current) setHover({ depth: NaN, max: NaN, loading: true, ...cur }); }, 300);
      const r = await fetchReading(runId, cur.lon, cur.lat, tSRef.current);
      clearTimeout(slow);
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
      if (!hoverAllowed()) { down = null; return; }
      const { x, y } = local(e);
      const moved = Math.hypot(x - down.x, y - down.y) > 4;
      down = null;
      if (moved) return;
      if (viewRef.current === "Plan" && onBuildingRef.current) {
        const hit = s.pick(new Cesium.Cartesian2(x, y));
        if (typeof hit?.id === "string") { setPinned(null); setHover(null); onBuildingRef.current(hit.id, e.shiftKey); return; }
      }
      if (pinnedRef.current) { setPinned(null); return; }
      const h = hoverRef.current;
      if (h && !h.loading) { setPinned({ depth: h.depth, max: h.max, ser: h.ser, lon: h.lon, lat: h.lat }); setHover(null); }
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
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerdown", onRDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("contextmenu", onContext);
    return () => {
      clearTimeout(timer);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseenter", onEnter);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerdown", onRDown);
      canvas.removeEventListener("pointerup", onUp);
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
      if (!cancelled) setWpSeries((cur) => ({ ...cur, [w.id]: ser }));
    }));
    return () => { cancelled = true; };
  }, [runId, wps]);

  // Where each waypoint is (place, ground, water, nearest building): needs no run, fetched once per waypoint.
  const aoiKey = aoi?.aoi_id;
  const askedPoint = useRef(new Set<string>());
  useEffect(() => {
    if (!aoiKey) return;
    wps.forEach((w) => {
      const k = `${aoiKey}|${w.id}`;
      if (askedPoint.current.has(k)) return;
      askedPoint.current.add(k);
      getPointInfo(aoiKey, w.lon, w.lat).then((p) => setWpPoint((cur) => ({ ...cur, [k]: p })));
    });
  }, [aoiKey, wps]);
  // The run's per-building max depth (the same file that colours the buildings), for "nearest building".
  const runFinished = run?.status === "done";
  const bdUrl = runFinished && run?.building_depths ? `${runsBase.replace(/\/$/, "")}/${run.run_id}/${run.building_depths}` : undefined;
  useEffect(() => {
    setBDepths(null);
    if (!bdUrl) return;
    let cancelled = false;
    getBuildingDepths(bdUrl).then((m) => { if (!cancelled) setBDepths(m); });
    return () => { cancelled = true; };
  }, [bdUrl]);
  const wpInfo = useMemo(() => Object.fromEntries(wps.map((w): [number, WaypointInfo] => {
    const k = `${aoiKey}|${w.id}`;
    const point = k in wpPoint ? wpPoint[k] : undefined;
    const bid = point?.building?.id;
    return [w.id, { point, hasRun: runFinished, depth_m: wpReadings[w.id]?.depth, series: w.id in wpSeries ? wpSeries[w.id] : undefined,
      building_max_m: bid != null && bDepths ? bDepths.get(bid) ?? null : undefined }];
  })), [aoiKey, wps, wpPoint, wpReadings, wpSeries, bDepths, runDone]);
  // Same description for the Inspect tab's waypoint list.
  useEffect(() => { setWaypointInfo(wpInfo); }, [wpInfo]);
  useEffect(() => () => setWaypointInfo({}), []);

  // Inspect store: the pinned point wins over the hover.
  const shown = pinned ?? hover;
  useEffect(() => {
    setInspect(shown && !shown.loading ? { lon: shown.lon, lat: shown.lat, depth_m: shown.depth, max_m: shown.max,
      wet_t: shown.ser?.first_flooded_s ?? null, impassable_t: shown.ser?.first_impassable_s ?? null } : null);
  }, [shown?.lon, shown?.lat, shown?.depth, shown?.max, shown?.ser]);
  useEffect(() => () => setInspect(null), []);
  // The pinned point's depth series feeds the dock chart.
  useEffect(() => { setPinnedSeries(pinned?.ser?.depth_m ?? null); }, [pinned?.ser]);
  useEffect(() => () => setPinnedSeries(null), []);

  // Hover tooltips stop while flying (free camera, playback) or drawing.
  useEffect(() => { if (mode === "free" || drawing || (mode === "fly" && fly.hud.playing)) setHover(null); }, [mode, drawing, fly.hud.playing]);

  const pickMode = (v: ViewName) => {
    setRouteMenu(false);
    if (v === "Free") { setHover(null); setMode("free"); return; }
    if (v === "Fly along") { startFly(); return; }
    if (modeRef.current !== "orbit") backToOrbit();
    pickView(v);
  };
  const startDraw = () => {
    setRouteMenu(false);
    if (modeRef.current !== "orbit") backToOrbit();
    setDrawPts([]); setDrawing(true);
  };
  const startFly = () => {
    if (route.length < 2) return;
    setHover(null); setRouteReady(false); pendingPlay.current = true; setMode("fly");
  };
  const finishDraw = (pts: LonLat[]) => {
    if (pts.length >= 2) { setFlyRoute(pts); setRouteReady(true); }
    setDrawing(false); setDrawPts([]);
  };

  // Route drawing: left clicks add vertices, double-click finishes.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !drawing) return;
    const canvas = viewer.canvas, s = viewer.scene;
    let down: { x: number; y: number } | null = null;
    const local = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const onDown = (e: PointerEvent) => { down = e.button === 0 ? local(e) : null; };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return;
      const { x, y } = local(e);
      const moved = Math.hypot(x - down.x, y - down.y) > 4;
      down = null;
      if (moved) return;
      const p = s.globe.pick(viewer.camera.getPickRay(new Cesium.Cartesian2(x, y)) as Cesium.Ray, s);
      if (!p) return;
      const c = Cesium.Cartographic.fromCartesian(p);
      setDrawPts((cur) => [...cur, [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)]]);
    };
    const onDbl = () => {
      const pts = drawRef.current.pts.slice(0, -1);  // the second click of the double-click added a duplicate vertex
      finishDraw(pts.length >= 2 ? pts : drawRef.current.pts);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("dblclick", onDbl);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("dblclick", onDbl);
    };
  }, [viewer, drawing]);

  // The drawn route (or the one being drawn): 3 px danfo line clamped to ground, small vertex points.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const pts = drawing ? drawPts : route;
    if (!pts.length) return;
    const danfo = cssColor("--danfo"), ground = cssColor("--ground");
    const made: Cesium.Entity[] = [];
    if (pts.length >= 2) {
      made.push(viewer.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray(pts.flat()), width: 3, clampToGround: true, material: danfo } }));
    }
    for (const [lon, lat] of pts) {
      made.push(viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: { pixelSize: 7, color: danfo, outlineColor: ground, outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
    }
    return () => { if (!viewer.isDestroyed()) made.forEach((e) => viewer.entities.remove(e)); };
  }, [viewer, drawing, drawPts, route]);

  const dropWaypoint = useCallback((lon: number, lat: number) => {
    if (!inAoi(lon, lat)) return;
    setSelectedWp(addWaypoint(lon, lat).id);
  }, [inAoi]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        setPinned(null); setMenu(null); setSelectedPlace(null); setSelectedWp(null); setRouteMenu(false);
        if (drawing) { setDrawing(false); setDrawPts([]); } else if (modeRef.current !== "orbit") backToOrbit();
      }
      else if (drawing) {
        if (e.key === "Enter") { e.preventDefault(); finishDraw(drawPts); }
        else if (e.key === "Backspace") { e.preventDefault(); setDrawPts((p) => p.slice(0, -1)); }
      }
      else if (modeRef.current === "free") { /* WASD belongs to the free camera; waypoints come from the right-click menu */ }
      else if (modeRef.current === "orbit" && viewer && over.current && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "_"].includes(e.key)) {
        e.preventDefault();
        const c = viewer.camera;
        const step = Cesium.Math.toRadians(e.shiftKey ? 15 : 5);
        if (e.key === "ArrowLeft") reorient(c.heading - step);
        else if (e.key === "ArrowRight") reorient(c.heading + step);
        else if (e.key === "ArrowUp") reorient(undefined, Cesium.Math.clamp(c.pitch + step, MIN_PITCH, MAX_PITCH));
        else if (e.key === "ArrowDown") reorient(undefined, Cesium.Math.clamp(c.pitch - step, MIN_PITCH, MAX_PITCH));
        else {
          const carto = Cesium.Cartographic.fromCartesian(c.positionWC);
          const agl = Math.max(100, carto.height - (viewer.scene.globe.getHeight(carto) ?? 0));
          if (e.key === "-" || e.key === "_") c.zoomOut(agl * 0.2); else c.zoomIn(agl * 0.2);
        }
      }
      else if ((e.key === "w" || e.key === "W") && over.current && cursor.current) { dropWaypoint(cursor.current.lon, cursor.current.lat); }
      else if ((e.key === "Backspace" || e.key === "Delete") && selectedWp !== null) { e.preventDefault(); removeWaypoint(selectedWp); setSelectedWp(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dropWaypoint, selectedWp, drawing, drawPts, viewer, reorient, backToOrbit]);

  // ----- places -----
  const [places, setPlaces] = useState<Place[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);
  const [area, setArea] = useState<Area | null>(null);
  const aoiId = aoi?.aoi_id;
  useEffect(() => {
    setPlaces([]); setSelectedPlace(null); setRain({ places: [] });
    if (!aoiId) return;
    let cancelled = false;
    fetch(`${API}/api/aoi/${aoiId}/layer/places`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) { const ps = parsePlaces(d); setPlaces(ps); setRain({ places: ps }); } }).catch(() => { /* no places layer */ });
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
      {aoi && <Globe aoi={aoi} frames={frames} framesB={framesB} split={split} tS={tS} ionToken={ionToken} buildingsUrl={buildingsUrl}
        buildingDepthsUrl={run?.building_depths ? `${runsBase.replace(/\/$/, "")}/${run.run_id}/${run.building_depths}` : undefined}
        onViewer={(v) => { setViewer(v); setMapViewer(v); onViewer?.(v); }} />}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
        {underlay}
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
              <EventMarker color={EVENT_ICON[m.kind].color} name={serverEventLabel(e)} sub={`${fmtT(e.t_s)}${e.place ? ` · ${e.place}` : ""}`} muted={e.t_s > tS} />
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
            <WaypointPin n={w.n} lon={w.lon} lat={w.lat} info={wpInfo[w.id]} selected={selectedWp === w.id} onSelect={() => setSelectedWp(w.id)}
              onRemove={() => { removeWaypoint(w.id); setSelectedWp(null); }} />
          </Anchored>
        ))}

        {pinned && (
          <Anchored anchors={anchors} scene={scene} lon={pinned.lon} lat={pinned.lat} dx={16} dy={-10}>
            <Tooltip r={pinned} tS={tS} cellM={cellM} pinned outside={outsideDomain(run, pinned.lon, pinned.lat, aoi?.grid.bounds_wgs84)} style={{ pointerEvents: "auto" }} />
          </Anchored>
        )}
        {!pinned && hover && (
          <div ref={tipEl} style={{ position: "absolute", left: tooltipLeft(hover.x), top: hover.y - 10 }}>
            <Tooltip r={hover} tS={tS} cellM={cellM} pinned={false} outside={outsideDomain(run, hover.lon, hover.lat, aoi?.grid.bounds_wgs84)} />
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
        {run && !!frames?.length && !closeUp.active && (
          <div style={{ position: "absolute", top: 30, left: 64, pointerEvents: "auto" }}>
            <ProvenanceBadge kind={kind}>{`${kind === "placeholder" ? "Placeholder physics" : "Simulated"} · ${fmtT(tS)}`}</ProvenanceBadge>
          </div>
        )}
        <div data-declutter-block style={{ position: "absolute", top: 16, right: 16, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <RouteButton drawing={drawing} menuOpen={routeMenu} hasRoute={route.length >= 2} hasEvac={!!evac}
            onDraw={startDraw} onCancel={() => { setDrawing(false); setDrawPts([]); }} onToggleMenu={() => setRouteMenu((v) => !v)}
            onEvac={() => { if (evac) setFlyRoute(evac); setRouteMenu(false); }} onClear={() => { clearFlyRoute(); setRouteMenu(false); }} />
          <ViewSwitch active={active} onPick={pickMode} canFly={route.length >= 2} />
        </div>
        {/* Below the route and camera controls, so it never covers them. */}
        <span data-declutter-block style={{ ...pill, position: "absolute", left: "50%", top: 62, transform: "translateX(-50%)", maxWidth: "calc(100% - 32px)" }}>
          {simNow.running ? (rs.mode === "cell" ? "Simulating · the cloud follows the storm cell and rains harder as the pattern peaks" : "Simulating · the rain grows and eases with the time pattern")
            : rs.picking === "polygon" ? "Click to add points · Enter to finish · Backspace to undo · Esc to cancel"
            : rs.picking === "centre" ? "Click the map to place the storm centre · Esc to cancel"
            : rs.visible && rs.mode === "cell" && !drawing && mode === "orbit" ? "Click to place the storm · drag the ring to resize · drag the arrow to steer"
            : drawing ? "Click to add points · Enter to finish · Backspace to undo · Esc to cancel"
            : mode === "free" ? "Drag to look · WASD to move · E / Q up and down · Shift faster · Esc to orbit"
            : mode === "fly" ? "Drag to look around · scroll or E / Q for height · Esc to orbit"
            : "Drag to pan · right-drag or Ctrl+drag to orbit and tilt · scroll to zoom · W to drop a waypoint"}
        </span>
        {mode === "free" && (
          <span style={{ ...pill, position: "absolute", left: "50%", bottom: 26, transform: "translateX(-50%)", ...FIG }}>
            Move speed {freeSpeed.toFixed(freeSpeed < 1 ? 2 : 1)}× · scroll to change
          </span>
        )}
        {mode === "fly" && <FlyHudCard hud={fly.hud} cellM={cellM} link={effLink} canLink={runDone} onLink={setLink}
          status={!run ? "No simulation yet: terrain and buildings only" : run.status === "failed" ? "Simulation failed: no water shown"
            : !runDone ? "Simulating… water appears when it finishes" : `Flood at ${fmtT(tS)}${clock.get().playing ? ", playing" : ""}`}
          below={belowSeries ? waterBelow(belowSeries, tS) : null}
          onPlay={flyPlay} onSpeed={fly.setSpeed} onSeek={fly.seek} onExit={backToOrbit} />}
        {mode !== "fly" && routeReady && !drawing && route.length >= 2 && (
          <RouteReadyCard len={routeLength(route)} speed={fly.hud.speed} onFly={startFly} onRedraw={() => { setRouteReady(false); startDraw(); }}
            onClear={() => { clearFlyRoute(); setRouteReady(false); }} onClose={() => setRouteReady(false)} />
        )}

        <CloseUpMap viewer={viewer} scene={scene} anchors={anchors} runId={run?.status === "done" ? run.run_id : undefined} runsBase={runsBase} buildingsUrl={buildingsUrl} />
        <GpuBoxMap viewer={viewer} scene={scene} anchors={anchors} hidden={!!closeUp.active} runKey={runId} />
        <DomainMap viewer={viewer} scene={scene} anchors={anchors} bbox={domainBbox(run, aoi?.grid.bounds_wgs84)} aoiBounds={aoi?.grid.bounds_wgs84} basemap={lay.basemap} hidden={!!closeUp.active} />
        {rainStorm && <RainMap viewer={viewer} scene={scene} anchors={anchors} basemap={lay.basemap} opacity={lay.rain.opacity} hasRun={!!runId} storm={rainStorm} />}
        <CloudsRain viewer={viewer} scene={scene} anchors={anchors} run={run} src={weather} hidden={view === "Plan" || !!closeUp.active} />
        {viewState.coords && <CoordChip viewer={viewer} scene={scene} anchors={anchors} aoiId={aoi?.aoi_id} />}
        {/* One bottom-left slot for every map legend, stacked so they never overlap. */}
        <div data-declutter-block style={{ position: "absolute", left: 16, bottom: viewState.coords ? 84 : 44, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, pointerEvents: "none" }}>
          {legend && arrivalOn && <ArrivalLegendBox legend={legend} />}
        {rs.visible && rs.preview && (
          <div className="ft-legend" style={{ pointerEvents: "none", boxShadow: "var(--shadow-float)" }}>
            <span className="ft-stat-label">Rain over the storm</span>
            <span style={{ width: 168, height: 10, borderRadius: "var(--radius-pill)", border: "var(--stroke-hairline) solid var(--hairline)",
              background: "linear-gradient(90deg, color-mix(in srgb, var(--depth-3) 6%, transparent), var(--depth-3))" }} />
            <span style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--ink-muted)", ...FIG }}>
              <span>0</span><span>{Math.round(rs.preview.vmax_mm / 2)}</span><span>{Math.round(rs.preview.vmax_mm)} mm</span></span>
          </div>
        )}
          <FlowLegend runId={run?.status === "done" ? run.run_id : undefined} />
          {!closeUp.active && <DrainsLegend aoi={aoi} run={run} runsBase={runsBase} />}
        </div>
        <DrainsMap viewer={viewer} scene={scene} anchors={anchors} aoi={aoi} run={run} tS={tS} basemap={lay.basemap} runsBase={runsBase} hidden={!!closeUp.active} />
        <FlowHazardMap viewer={viewer} scene={scene} anchors={anchors} aoi={aoi} run={run} tS={tS} basemap={lay.basemap} frames={frames} buildingsUrl={buildingsUrl} onBuilding={onBuilding} />

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

        <div data-declutter-block style={{ position: "absolute", right: 16, bottom: 26, display: "flex", alignItems: "flex-end", gap: 8, pointerEvents: "auto" }}>
          <ScaleBar nice={cam.nice} px={cam.px} />
          <div style={{ ...groupStyle, gap: 2 }}>
            <button type="button" data-tour="plan" aria-pressed={view === "Plan"} onClick={() => pickView("Plan")} style={segBtn(view === "Plan", 24)}>2D</button>
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
