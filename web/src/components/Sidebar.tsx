// Sidebar (rev 5 tabs() + cards): Layers / Inspect / Scenario / Sources, or Compare / Inspect / Sources in Compare mode.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Broom, CheckCircle, Clock, CloudRain, Crosshair, Path, Play, Ruler, Spinner, Stop, TrendUp, Waves, X } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { AOIManifest, RunManifest } from "../lib/api";
import { getJudgeKey, getLevelSensitivity, setJudgeKey } from "../lib/api";
import type { LevelSensitivity } from "../lib/api";
import { lazyNamed } from "../lib/lazy";
const FlowHazardCard = lazyNamed(() => import("./FlowHazard"), "FlowHazardCard");
import { LayerKey, setAerial, setBasemap, setImageryMode, setLayer, setPhotorealDown, useLayers } from "../lib/layers";
import { downText, isDown } from "../lib/photoreal";
import type { PhotorealDown } from "../lib/photoreal";
import type { AerialSource } from "../lib/layers";
import { useInspect } from "../lib/inspect";
import { removeWaypoint, useWaypointInfo, useWaypoints } from "../lib/waypoints";
import { setFocus } from "../lib/focus";
import { coord, placeLabel, WaypointDetails } from "./WaypointDetails";
import { useExtras } from "../lib/extras";
import { clock as playhead, useClock } from "../lib/clock";
import { clearSafeRoute, fmtEta, fmtKm, setSafeRoute, shelterName, usualCut, useSafeRoute } from "../lib/saferoute";
import { useTouch } from "../lib/breakpoint";
import { Card, CardLock, Field, FIG, mono, MiniSlider, NumberInput, raisedButton, Segmented, TextAction } from "./rev5";
import { fmtT } from "./ds";
import { Slider } from "./controls/Slider";
import { Switch } from "./controls/Switch";
import { Notice } from "./Notice";
import { LockoutNote } from "./LockoutNote";
import { useLockout } from "../lib/lockout";
import { Button } from "./ds";
import { RainAreaCard, RainPreviewCard } from "./RainCards";
const DrainageCard = lazyNamed(() => import("./Drainage"), "DrainageCard");
import { easeLeft } from "../lib/simbar";
import { countNote, noWater, requestAddAtCentre, useObservations, useObsUi } from "../lib/observations";
import { useDrainage } from "../lib/drainage";
import { useRain } from "../lib/rain";
import { setCloseUp, useCloseUp } from "../lib/patch3d";
import { TextField } from "./controls/TextField";
import { Tooltip, Tip } from "./controls/Tooltip";
import { Button as CtlButton } from "./controls/Button";
const GpuCard = lazyNamed(() => import("./GpuCard"), "GpuCard");

export type Pattern = "uniform" | "front_loaded" | "center_peaked";
export type Failure = { message: string; retryable: boolean };
const TABS = ["Layers", "Inspect", "Scenario", "Sources"] as const;
const COMPARE_TABS = ["Compare", "Layers", "Inspect", "Sources"] as const;
const AGENT_TABS = ["Layers", "Inspect", "Agent", "Sources"] as const;
export type Tab = (typeof TABS)[number] | "Compare" | "Agent" | "Timeline";

function Tabs({ tabs, active, onTab }: { tabs: readonly Tab[]; active: Tab; onTab: (t: Tab) => void }) {
  // Five tabs (the tablet drawer's Timeline) only fit 360 px with tighter padding.
  const tight = tabs.length > 4;
  const pad = tight ? "0 7px" : "0 12px";
  return (
    <nav aria-label="Sidebar" style={{ display: "flex", alignItems: "flex-end", padding: tight ? "0 6px" : "0 16px", background: "var(--surface)", borderBottom: "1px solid var(--hairline)", flex: "none" }}>
      {tabs.map((n) => {
        const on = n === active;
        const st: CSSProperties = on
          ? { color: "var(--ink)", fontWeight: 600, background: "var(--raised-bg)", boxShadow: "inset 0 -2px 0 var(--ink), inset 0 1px 0 var(--elev-hi)", borderRadius: "var(--radius-md) var(--radius-md) 0 0", padding: pad }
          : { color: "var(--ink-muted)", fontWeight: 400, padding: pad };
        return <CtlButton variant="text" key={n} type="button" data-tour={n === "Scenario" ? "scenario" : n === "Layers" ? "layers" : undefined} aria-current={on ? "page" : undefined} onClick={() => onTab(n)}
          style={{ height: 38, marginRight: tight ? 0 : 4, marginTop: 6, background: "transparent", border: 0, font: "inherit", whiteSpace: "nowrap", ...st }}>{n}</CtlButton>;
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

const RAIN_T = svgThumb(<><rect width="30" height="30" fill="var(--depth-3)" opacity=".18" /><circle cx="15" cy="15" r="9" fill="var(--depth-3)" opacity=".5" /><circle cx="15" cy="15" r="4" fill="var(--depth-3)" /><circle cx="15" cy="15" r="12" fill="none" stroke="var(--danfo)" strokeWidth="1.2" strokeDasharray="3 2" /></>);
const CLOSEUP_T = svgThumb(<><rect x="6" y="6" width="18" height="18" fill="var(--depth-3)" opacity=".28" /><rect x="6" y="6" width="18" height="18" fill="none" stroke="var(--ink)" strokeWidth="1.2" strokeDasharray="3 2" /><rect x="12" y="11" width="7" height="7" fill="var(--ink-muted)" /></>);
const DRAINS_T = svgThumb(<><path d="M-2 20 L32 12" stroke="var(--ground)" strokeWidth="6" /><path d="M-2 20 L32 12" stroke="var(--danfo)" strokeWidth="3.5" /><path d="M14 -2 L19 16" stroke="var(--depth-3)" strokeWidth="3" strokeDasharray="4 2.5" /><circle cx="14" cy="6" r="3" fill="var(--ground)" stroke="var(--ink)" strokeWidth="1.2" /></>);
const BOUNDARY_T = svgThumb(<path d="M-2 21 C7 13 15 23 32 9" stroke="var(--depth-1)" strokeWidth="2" fill="none" opacity=".9" />);

const ROWS: { key: LayerKey; name: string; thumb: ReactNode; slider?: boolean; note?: string }[] = [
  { key: "water", name: "Water depth", thumb: imgThumb("water"), slider: true },
  { key: "buildings", name: "Buildings by depth", thumb: imgThumb("buildings"), slider: true },
  { key: "roads", name: "Impassable roads", thumb: ROADS_T, note: "≥ 0.30 m" },
  { key: "places", name: "Places", thumb: PLACES_T },
  { key: "arrival", name: "Time to flood", thumb: ARRIVAL_T, note: "Arrival map" },
  { key: "route", name: "Evacuation route", thumb: ROUTE_T },
  { key: "photos", name: "Observations", thumb: PHOTO_T, note: "None yet" },
  { key: "terrain", name: "Terrain (3D)", thumb: imgThumb("terrain") },
  { key: "imagery", name: "Aerial imagery", thumb: imgThumb("aerial"), slider: true },
  { key: "rain", name: "Rain area", thumb: RAIN_T, slider: true },
  { key: "boundary", name: "Lagoon / sea edge", thumb: BOUNDARY_T },
  { key: "closeups", name: "3D close-ups", thumb: CLOSEUP_T, note: "Outlines" },
  { key: "weather", name: "Clouds and rain", thumb: RAIN_T, note: "While simulating" },
  { key: "drains", name: "Drains", thumb: DRAINS_T, note: "How full" },
];

const seg = (on: boolean) => ({ height: 22, padding: "0 9px", border: 0, borderRadius: 3, font: "inherit", fontSize: "inherit", boxShadow: "none",
  ...(on ? { background: "var(--ink)", color: "var(--ground)", fontWeight: 600 } : { background: "transparent", color: "var(--ink-muted)", fontWeight: 400 }) });
const KEY_NOTE = "Google imagery needs the judge key.";

/** Aerial source: Bing for everyone, Google Map Tiles for judges (key from the server, behind the judge key). */
function AerialSourceRow() {
  const lay = useLayers();
  const [key, setKey] = useState(getJudgeKey);
  const keyRef = useRef<HTMLInputElement>(null);
  const lock = useLockout();
  const needKey = lay.aerialNote === KEY_NOTE;
  useEffect(() => { if (needKey) keyRef.current?.focus(); }, [needKey]);
  // The server decides (judge key or team token); a 403 comes back as KEY_NOTE and brings up the key box.
  // While key checks are locked (kept across reloads), Google opens the key box with the countdown instead of asking.
  const pick = (a: AerialSource) => (a === "google" && lock ? setAerial("bing", KEY_NOTE) : setAerial(a));
  const aerial = lay.basemap === "aerial";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 14px 0", fontSize: 12, color: "var(--ink-muted)", opacity: aerial ? 1 : 0.45 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Aerial
        <span style={{ display: "flex", marginLeft: "auto", padding: 2, gap: 2, background: "var(--ground)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)" }}>
          {(["bing", "google"] as const).map((a) => (
            <Tooltip key={a} text={a === "bing" ? "Bing aerial imagery, for everyone" : "Google satellite imagery, for judges (needs the judge key)"}><CtlButton variant="segment" pressed={lay.aerial === a} type="button" disabled={!aerial} onClick={() => pick(a)} style={seg(lay.aerial === a)}>
              {a === "bing" ? "Bing" : "Google"}</CtlButton></Tooltip>
          ))}
        </span>
      </div>
      {lay.aerialNote && <span role="status" style={{ color: needKey ? "var(--ink)" : "var(--ink-muted)" }}>{lay.aerialNote}</span>}
      {needKey && (
        <form onSubmit={(e) => { e.preventDefault(); if (key.trim() && !lock) { setJudgeKey(key.trim()); setAerial("google"); } }} style={{ display: "flex", gap: 6 }}>
          <TextField ref={keyRef} type="password" autoComplete="off" placeholder="Paste the judge key" aria-label="Judge key" value={key} onChange={(e) => setKey(e.target.value)}
            style={{ flex: 1, height: 28, padding: "0 8px", fontSize: 12 }} />
          <CtlButton variant="raised" type="submit" disabled={!key.trim() || !!lock} style={{ height: 28, padding: "0 10px", border: "1px solid var(--control-edge)", borderRadius: "var(--radius-md)",
            background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", font: "inherit", fontSize: 12, fontWeight: 500,
            cursor: lock ? "default" : "pointer", opacity: lock ? 0.6 : 1 }}>Use Google</CtlButton>
        </form>
      )}
      {needKey && lock && <LockoutNote lock={lock} />}
    </div>
  );
}

/** Under Base map when Google's 3D tiles failed: why the map is aerial, and Try 3D again once it may work (never for a
 *  refused key; after Retry-After or 10 min for the daily limit; at once otherwise). */
function PhotorealDownRow({ down }: { down: PhotorealDown }) {
  const [, tick] = useState(0);
  const wait = down.retryAt - Date.now();
  useEffect(() => {
    if (!(wait > 0) || !Number.isFinite(wait)) return;
    const id = window.setTimeout(() => tick((n) => n + 1), Math.min(wait + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(id);
  }, [down, wait]);
  const ready = !isDown(down);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 14px 0", fontSize: 12, lineHeight: "16px" }}>
      <span role="status" style={{ color: "var(--ink)" }}>{downText(down.kind)}</span>
      {down.kind !== "key" && (
        <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-muted)" }}>
          <CtlButton variant="text" type="button" disabled={!ready} onClick={() => { setPhotorealDown(null); setBasemap("photoreal"); }}
            style={{ padding: 0, border: 0, background: "transparent", font: "inherit", fontWeight: 600, color: ready ? "var(--ink)" : "var(--ink-muted)", cursor: ready ? "pointer" : "default" }}>Try 3D again</CtlButton>
          {!ready && <span>from {new Date(down.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
        </span>
      )}
    </div>
  );
}

function LayersCard({ aoiId, runId }: { aoiId?: string; runId?: string }) {
  const lay = useLayers();
  const obs = useObservations(aoiId, runId);
  const photorealOff = !!lay.photorealDown;  // back only through Try 3D again
  const imageryMode = lay.imageryMode;
  const { boundary } = useExtras();
  const rainSet = useRain().mode !== "whole";
  const patches = useCloseUp().patches;
  const hasCloseups = patches.length > 0;
  const hasDrains = useDrainage().def != null;
  return (
    <section style={{ display: "flex", flexDirection: "column", flex: "none", padding: "4px 0", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: "var(--card-shadow)" }}>
      {ROWS.filter((r) => (r.key !== "boundary" || boundary) && (r.key !== "rain" || rainSet) && (r.key !== "closeups" || hasCloseups) && (r.key !== "drains" || hasDrains)).map((r) => {
        const { on, opacity } = lay[r.key];
        const pct = Math.round(opacity * 100);
        return (
          <Fragment key={r.key}><Tip text={r.key === "boundary" ? boundary?.features[0]?.properties.note : undefined}><div style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, minHeight: 38, padding: "0 14px", color: on ? undefined : "var(--ink-muted)" }}>
            <Switch fill on={on} onChange={(v) => setLayer(r.key, { on: v })} label={<><span aria-hidden="true" style={{ display: "flex", flex: "none", opacity: on ? 1 : 0.45 }}>{r.thumb}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span></>} />
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {r.slider ? (
                <>
                  <MiniSlider pct={pct} label={`${r.name} opacity`} onChange={(p) => setLayer(r.key, { opacity: p / 100 })} />
                  <span style={{ width: 34, textAlign: "right", fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{pct}%</span>
                </>
              ) : r.key === "closeups" ? (
                // The box may be off screen, so the row can open it too.
                <CtlButton variant="raised" type="button" onClick={(e) => { e.preventDefault(); setCloseUp({ active: patches[0].patch_id }); }}
                  style={{ height: 24, padding: "0 9px", border: "1px solid var(--control-edge)", borderRadius: "var(--radius-md)", background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", font: "inherit", fontSize: 12, fontWeight: 500, cursor: "pointer" }}>
                  Open</CtlButton>
              ) : <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{r.key === "photos" ? (obs ? countNote(obs.filter((o) => !noWater(o)).length) : "") : r.note ?? ""}</span>}
            </span>
          </div></Tip>
          {r.key === "photos" && <div style={{ padding: "0 14px 6px" }}><CtlButton variant="text" type="button" onClick={() => requestAddAtCentre()} data-obs-add="" style={{ fontSize: 12, height: 26, color: "var(--ink)" }}>+ Add a photo of the water</CtlButton></div>}
          </Fragment>
        );
      })}
      <div data-basemap-row="" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 0", marginTop: 4, borderTop: "1px solid var(--hairline)", fontSize: 12, color: "var(--ink-muted)" }}>
        Base map
        <span style={{ display: "flex", marginLeft: "auto", padding: 2, gap: 2, background: "var(--ground)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)" }}>
          {(["photoreal", "aerial"] as const).map((m) => {
            const on = lay.basemap === m;
            const off = m === "photoreal" && photorealOff;
            return <Tooltip key={m} text={m === "photoreal" ? (off && lay.photorealDown ? downText(lay.photorealDown.kind) : "Google Photorealistic 3D Tiles") : "Aerial imagery on terrain; shows every building by depth"}><CtlButton variant="segment" pressed={on} type="button" disabled={off} onClick={() => setBasemap(m)}
              style={{ height: 22, padding: "0 9px", border: 0, borderRadius: 3, font: "inherit", fontSize: "inherit", boxShadow: "none", ...(on ? { background: "var(--ink)", color: "var(--ground)", fontWeight: 600 } : { background: "transparent", color: "var(--ink-muted)", fontWeight: 400 }) }}>
              {m === "photoreal" ? "Photoreal 3D" : "Aerial"}</CtlButton></Tooltip>;
          })}
        </span>
      </div>
      {lay.photorealDown && <PhotorealDownRow down={lay.photorealDown} />}
      {lay.googleAvailable && <AerialSourceRow />}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 6px", fontSize: 12, color: "var(--ink-muted)", opacity: lay.basemap === "aerial" ? 1 : 0.45 }}>
        Imagery
        <span style={{ display: "flex", marginLeft: "auto", padding: 2, gap: 2, background: "var(--ground)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)" }}>
          {(["colour", "greyscale"] as const).map((m) => {
            const on = imageryMode === m;
            return <CtlButton variant="segment" pressed={on} key={m} type="button" disabled={lay.basemap !== "aerial"} onClick={() => setImageryMode(m)}
              style={{ height: 22, padding: "0 9px", border: 0, borderRadius: 3, font: "inherit", fontSize: "inherit", boxShadow: "none", ...(on ? { background: "var(--ink)", color: "var(--ground)", fontWeight: 600 } : { background: "transparent", color: "var(--ink-muted)", fontWeight: 400 }) }}>
              {m === "colour" ? "Colour" : "Greyscale"}</CtlButton>;
          })}
        </span>
      </div>
    </section>
  );
}

// ---- inspect ----
function WaypointsCard() {
  const touch = useTouch();
  const wps = useWaypoints();
  const info = useWaypointInfo();
  const ib = { width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, background: "transparent", border: 0,
    borderRadius: "var(--radius-md)", color: "var(--ink-muted)", cursor: "pointer" } as const;
  return (
    <Card title="Waypoints" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12, ...FIG }}>{wps.length || ""}</span>}>
      {wps.length === 0 ? (
        <p style={{ margin: 0, padding: "14px", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>{touch ? "Long-press the map to drop a waypoint." : "Right-click the map or press W to drop a waypoint."}</p>
      ) : (
        <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {wps.map((w, k) => (
            <li key={w.id} style={{ display: "grid", gridTemplateColumns: "20px minmax(0, 1fr) auto", gap: 10, padding: "10px 8px 10px 14px", borderTop: k ? "1px solid var(--hairline)" : undefined }}>
              <span style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--danfo)", color: "var(--on-danfo)",
                borderRadius: 3, fontSize: 11, fontWeight: 700, ...FIG }}>{w.n}</span>
              <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{placeLabel(info[w.id]) ?? `Waypoint ${w.n}`}</span>
                <WaypointDetails lon={w.lon} lat={w.lat} info={info[w.id]} />
              </span>
              <span style={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
                <Tooltip text="Fly to"><CtlButton variant="icon" type="button" aria-label={`Fly to waypoint ${w.n}`} onClick={() => setFocus({ lon: w.lon, lat: w.lat })} style={ib}><Crosshair size={14} weight="bold" /></CtlButton></Tooltip>
                <Tooltip text="Remove"><CtlButton variant="icon" type="button" aria-label={`Remove waypoint ${w.n}`} onClick={() => removeWaypoint(w.id)} style={ib}><X size={14} weight="bold" /></CtlButton></Tooltip>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

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

/** Safe route (board 12): the dry route to the nearest shelter for the frame the playhead is on. Shown once a spot is picked. */
function SafeRouteCard({ passM }: { passM: number }) {
  const s = useSafeRoute();
  if (!s.origin) return null;
  const r = s.route, dry = !!r?.reachable;
  const muted: CSSProperties = { margin: 0, color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" };
  const row = (k: string, v: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "var(--ink-muted)" }}>{k}</span>
      <span style={{ fontWeight: 600, textAlign: "right", ...FIG }}>{v}</span>
    </div>
  );
  const btn: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, height: 32, padding: "0 12px", fontWeight: 600 };
  return (
    <Card title="Safe route">
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px 14px" }}>
        {r && dry && <>
          {row("To", shelterName(r.destination_name))}
          {row("Distance", r.length_km != null ? fmtKm(r.length_km) : "n/a")}
          {row("Time", r.eta_min != null ? `${fmtEta(r.eta_min)} on foot` : "n/a")}
          {usualCut(r, s.usual)
            ? row(`Flooded ${s.blocked.length === 1 ? "stretch" : "stretches"} avoided`, `${s.blocked.length} on the usual route at ${fmtT(s.t ?? 0)}`)
            : <p style={{ margin: 0, fontWeight: 600 }}>Usual route is dry at {fmtT(s.t ?? 0)}</p>}
        </>}
        {r && !dry && <>
          <div style={{ display: "flex", gap: 8, padding: "8px 10px", borderLeft: "3px solid var(--hazard)", background: "color-mix(in srgb, var(--hazard) 10%, var(--surface))" }}>
            <span style={{ fontSize: 13 }}><b>No dry route at {fmtT(s.t ?? 0)}.</b> Every road out of this spot is over {passM} m deep.{s.clearT != null && ` The first one clears at ${fmtT(s.clearT)}.`}</span>
          </div>
          {s.clearT != null && <CtlButton variant="raised" type="button" onClick={() => playhead.set({ t_s: s.clearT ?? 0 })} style={{ ...btn, alignSelf: "flex-start" }}>Jump to {fmtT(s.clearT)}</CtlButton>}
        </>}
        {!r && !s.error && <p style={muted}>Finding the route…</p>}
        {s.error && <p style={{ ...muted, color: "var(--hazard)" }}>{s.error}</p>}
        <p style={muted}>The route follows the playhead: move the timeline and it is recomputed for that moment.</p>
        {s.picking && <p style={muted}>Click the map to set the start.</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <CtlButton variant="raised" type="button" aria-pressed={s.picking} onClick={() => setSafeRoute({ picking: !s.picking })} style={btn}>
            <Path size={14} weight="bold" />Pick another start
          </CtlButton>
          <CtlButton variant="raised" type="button" onClick={clearSafeRoute} style={btn}>
            <X size={14} weight="bold" />Clear route
          </CtlButton>
        </div>
      </div>
    </Card>
  );
}

function CursorCard({ tS, passM }: { tS: number; passM: number }) {
  const touch = useTouch();
  const i = useInspect();
  const empty = i == null;
  const vd = { borderLeft: "1px solid var(--hairline)" };
  return (
    <Card title="At the cursor" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>{touch ? "Tap" : "Hover"} · <span style={FIG}>{fmtT(tS)}</span></span>}>
      {i == null ? (
        <p style={{ margin: 0, padding: "14px", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>{touch ? "Tap the map" : "Hover the map"}</p>
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

export const describeIv = (iv: { type: string; [k: string]: unknown }) =>
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
    ...(typeof s?.rain_generated_m3 === "number" && typeof s?.rain_in_aoi_m3 === "number"
      ? [["Rain outside the model area", <span style={FIG}>{n0(Math.max(0, Math.round(s.rain_generated_m3 - s.rain_in_aoi_m3)))} m³</span>] as [string, ReactNode]] : []),
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
  /** A shared link whose run or area is gone: shown once at the top of Scenario until dismissed. */
  linkNote?: { message: string; detail: string; onDismiss: () => void } | null;
  sim: SimBar; onStop: () => void; onClear: () => void;
  /** A run is on the map (Simulate, a link, a replay or the agent) and nothing is running: Clear simulation shows. */
  canClear: boolean;
};

/** What the Simulate bar shows (board 8): before (cached or live), running, or done. */
export type SimBar =
  | { state: "checking" }
  | { state: "incomplete"; reason: string }
  | { state: "waking" }
  | { state: "cached" }
  | { state: "live"; estS: number | null }
  | { state: "running"; elapsedS: number; estS: number | null; fraction: number; simT: number; tEnd: number; measured: boolean;
      frames: [number, number] | null; queued: boolean; joined: boolean; starting: boolean;
      /** Runs ahead of this one on the instance, and the seconds until the solver is free (null: not known). */ ahead: number; queueS: number | null }
  | { state: "done"; tookS: number | null };

function StormCard(p: ScenarioProps) {
  const r = useRain();
  const whole = r.mode === "whole";
  const where = whole ? null : r.mode === "draw" || (r.mode === "place" && !r.placeAsCell) ? "Inside the area" : "At the centre";
  return (
    <Card title="Storm" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", display: "flex" }}><CloudRain size={16} weight="bold" /></span>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 14px 14px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Rain total"><NumberInput label="Rain total" value={p.rain} unit="mm" min={20} max={250} onChange={p.onRain} /></Field>
          <Field label="Duration"><NumberInput label="Duration" value={p.durationH} unit="h" min={1} max={6} onChange={p.onDuration} /></Field>
        </div>
        {where && <span style={{ marginTop: -6, color: "var(--ink-muted)" }}>{where}</span>}
        <Field label="Time pattern" hint={whole ? "Rain falls evenly over the whole area. The pattern only shapes it over time." : "The pattern shapes the rain over time. Where it falls is set in Rain area."}>
          <Segmented<Pattern> active={p.pattern} onChange={p.onPattern}
            options={[{ value: "uniform", label: "Uniform" }, { value: "front_loaded", label: "Front-loaded" }, { value: "center_peaked", label: "Centre-peaked" }]} />
        </Field>
      </div>
    </Card>
  );
}

const PRESETS = [{ label: "Normal", v: null }, { label: "Spring high", v: 0.5 }, { label: "High + surge", v: 1.0 }, { label: "Extreme", v: 1.5 }] as const;
function LevelCard({ level, onLevel, aoiId }: Pick<ScenarioProps, "level" | "onLevel"> & { aoiId?: string }) {
  // Measured per area (Eng A, /api/aoi/{id}/level_sensitivity); none (404) means no table, never another area's numbers.
  const [sens, setSens] = useState<LevelSensitivity | null>(null);
  useEffect(() => {
    setSens(null);
    if (!aoiId) return;
    let off = false;
    getLevelSensitivity(aoiId).then((t) => { if (!off) setSens(t); }, () => { /* no table for this area */ });
    return () => { off = true; };
  }, [aoiId]);
  const km2 = sens?.rows.map((r) => r.flooded_km2) ?? [];
  // Where the level barely changes the flood (Queens: high ground), the note says so instead of a table of equal rows.
  const matters = km2.length > 1 && (Math.max(...km2) - Math.min(...km2)) / Math.max(Math.min(...km2), 1e-6) >= 0.02;
  const note = sens?.note ? sens.note[0].toUpperCase() + sens.note.slice(1) + "." : null;
  const v = level ?? -0.5;
  const active = PRESETS.find((p) => p.v === level)?.label ?? null;
  return (
    <Card title={aoiId?.startsWith("lagos") ? "Lagoon / sea level" : "Sea level"} right={<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, color: "var(--ink-muted)", fontSize: 12 }}><Waves size={16} weight="bold" />Assumption</span>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 14px 12px" }}>
        <Field label="Preset">
          <Segmented<string> size={11.5} active={active} onChange={(l) => onLevel(PRESETS.find((p) => p.label === l)!.v)}
            options={PRESETS.map((p) => ({ value: p.label, label: p.label }))} />
        </Field>
        <Slider label={aoiId?.startsWith("lagos") ? "Lagoon / sea level" : "Sea level"} min={-0.5} max={1.5} step={0.1} value={v} text={`${v > 0 ? "+" : ""}${v.toFixed(1)} m`} lo="−0.5 m" hi="+1.5 m" onChange={onLevel} />
        <p style={{ margin: 0, color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
          {level == null ? "No tide intervention. " : `Level ${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} m. `}
          Holds the {aoiId?.startsWith("lagos") ? "lagoon and sea edge" : "sea edge"} at one level for the whole run. A scenario level, not an observed tide. Coastal areas only.
        </p>
      </div>
      {sens && matters && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, borderTop: "1px solid var(--hairline)" }}>
          <thead><tr style={{ color: "var(--ink-muted)" }}>
            <th style={{ padding: "7px 0 4px 14px", textAlign: "left", fontWeight: 500 }}>Level</th>
            <th style={{ padding: "7px 8px 4px", textAlign: "right", fontWeight: 500 }}>Flooded km²</th>
            <th style={{ padding: "7px 14px 4px 8px", textAlign: "right", fontWeight: 500 }}>Buildings</th></tr></thead>
          <tbody>{sens.rows.map((r) => (
            <tr key={r.level_m} style={Math.abs(r.level_m - v) < 0.05 ? { background: "var(--surface-raised)" } : undefined}>
              <td style={{ padding: "5px 0 5px 14px", ...FIG }}>{r.level_m > 0 ? "+" : r.level_m < 0 ? "−" : ""}{Math.abs(r.level_m).toFixed(1)} m</td>
              <td style={{ padding: "5px 8px", textAlign: "right", ...FIG }}>{r.flooded_km2.toFixed(1)}</td>
              <td style={{ padding: "5px 14px 5px 8px", textAlign: "right", ...FIG }}>{r.buildings.toLocaleString("en-US")}</td></tr>))}
          </tbody>
        </table>
      )}
      {sens && (
        <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: matters ? undefined : "1px solid var(--hairline)", color: "var(--ink-muted)", fontSize: 11, lineHeight: "15px" }}>
          {matters ? <>Sensitivity on {sens.storm}. {note} Ground height error (about 2 m) is larger than one step, so read this as a trend, not who floods.</> : note}
        </p>
      )}
    </Card>
  );
}

/** "2 min 40 s", "40 s". */
export const minSec = (s: number) => {
  const t = Math.max(0, Math.round(s)), m = Math.floor(t / 60);
  return m ? `${m} min${t % 60 ? ` ${t % 60} s` : ""}` : `${t} s`;
};
/** "1:14". */
const clock = (s: number) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

const simCard: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", background: "var(--surface)",
  border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: "var(--card-shadow)", flex: "none" };
const btn: CSSProperties = { height: 32, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "0 12px",
  borderRadius: "var(--radius-md)", font: "inherit", fontSize: 13, whiteSpace: "nowrap" };
const icon15 = { size: 15, weight: "bold" as const, "aria-hidden": true, style: { flex: "none" } };

function SimulateButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <CtlButton variant="danfo" type="button" disabled={disabled} onClick={onClick}
      style={{ ...btn, fontWeight: 600 }}>
      <Play size={14} weight="bold" aria-hidden="true" style={{ flex: "none" }} />Simulate
    </CtlButton>
  );
}

/** Queued behind another run: how long until the solver is free (eased: shown, from the server's queueS). No number when
 *  it is not known, or when the run ahead is saving (0 s for about a second); never "about 0 s". */
const waitText = (queueS: number | null, shown: number | null) =>
  queueS != null && queueS >= 1 && shown != null && shown >= 1 ? `Waiting for another run, about ${clock(shown)}` : "Waiting for another run";

/** The eta-based "N s left", eased (lib/simbar easeLeft) so a refined eta doesn't make it jump; resets between runs. */
function useEasedLeft(target: number | null, running: boolean) {
  const st = useRef<{ shown: number | null; at: number }>({ shown: null, at: 0 });
  if (!running) { st.current = { shown: null, at: 0 }; return null; }
  const now = performance.now();
  const dt = st.current.shown == null ? 0 : (now - st.current.at) / 1000;
  st.current = { shown: easeLeft(st.current.shown, target, dt), at: now };
  return st.current.shown;
}

function SimulateBar({ sim, busy, canRun, canClear, onSimulate, onStop, onClear }: Pick<ScenarioProps, "sim" | "busy" | "canRun" | "canClear" | "onSimulate" | "onStop" | "onClear">) {
  const box = useRef<HTMLDivElement>(null);
  const running = sim.state === "running";
  // The server's early queue estimates jump (and sometimes rise): ease the wait like the lock countdown.
  const waiting = sim.state === "running" && sim.queued && !sim.joined && sim.ahead > 0;
  const waitShown = useEasedLeft(waiting ? sim.queueS : null, waiting);
  // The running card is taller than the bar; keep Stop and the progress in view.
  const grown = running && sim.fraction > 0;
  useEffect(() => { if (running) box.current?.scrollIntoView({ block: "nearest" }); }, [running, grown]);
  if (sim.state === "running") {
    const est = sim.estS != null && sim.estS > 0 ? ` of about ${clock(sim.estS)}` : "";
    const model = `Model time ${sim.measured ? "" : "≈"}${fmtT(sim.simT)} of ${fmtT(sim.tEnd)}${sim.frames ? ` · frame ${sim.frames[0]} of ${sim.frames[1]}` : ""}`;
    return (
      <div ref={box} data-tour="simulate" role="status" aria-live="polite" style={simCard}>
        <div data-tour="sim-status" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Spinner {...icon15} color="var(--depth-3)" />
          <span style={{ fontWeight: 600 }}>{sim.starting ? "Starting the solver…" : sim.queued ? (sim.joined ? "Waiting for the same run" : sim.ahead > 0 ? waitText(sim.queueS, waitShown) : "Queued for the solver…") : "Simulating live"}</span>
          <span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12, ...FIG }}>{clock(sim.elapsedS)}{est}</span>
        </div>
        <span role="progressbar" aria-label="Simulation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sim.fraction * 100)}
          style={{ position: "relative", display: "block", height: 8, borderRadius: "var(--radius-pill)", background: "var(--ground)", boxShadow: "var(--inset-shadow)", overflow: "hidden" }}>
          <span style={{ position: "absolute", inset: `0 ${(100 - Math.min(1, Math.max(0, sim.fraction)) * 100).toFixed(1)}% 0 0`, background: "var(--depth-3)",
            borderRadius: "var(--radius-pill)", transition: "inset 0.8s linear" }} />
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-muted)", fontSize: 12, ...FIG }}>
          <span>{sim.starting ? "" : model}</span>
          <span style={{ marginLeft: "auto" }}>
            <CtlButton variant="raised" type="button" onClick={onStop} style={{ ...btn, ...raisedButton, fontWeight: 500 }}><Stop size={14} weight="bold" aria-hidden="true" style={{ flex: "none" }} />Stop</CtlButton>
          </span>
        </div>
        <p style={{ margin: 0, color: "var(--ink-muted)", fontSize: 12, lineHeight: "16px" }}>
          {sim.starting ? "Waiting for the server to answer. Changing the area stops it." : "Not cached: this storm runs on the 30 m solver now. Changing the area stops it."}
        </p>
      </div>
    );
  }
  const off = busy || !canRun;
  return (
    <div ref={box} data-tour="simulate" style={simCard}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, rowGap: 8 }}>
        {sim.state === "done" ? (
          <span data-tour="sim-status" style={{ fontSize: 12, color: "var(--ink-muted)", whiteSpace: "nowrap" }}>{sim.tookS == null ? "Opened from cache" : `Simulated · ${minSec(sim.tookS)}`}</span>
        ) : (
          <span data-tour="sim-status" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, lineHeight: "16px" }}>
            {sim.state === "cached" ? <CheckCircle {...icon15} color="var(--depth-3)" /> : sim.state !== "incomplete" && <Clock {...icon15} color="var(--ink-muted)" />}
            {sim.state === "cached" && <span><b>Cached.</b> Opens instantly.</span>}
            {sim.state === "live" && <span><b>Runs live,</b>{sim.estS != null ? ` about ${minSec(sim.estS)}.` : " time unknown."} Cached runs open instantly.</span>}
            {sim.state === "checking" && <span style={{ color: "var(--ink-muted)" }}>Checking the cache…</span>}
            {sim.state === "waking" && <span style={{ color: "var(--ink-muted)" }}>Waking the server… (first request after a quiet spell can take up to 30 s)</span>}
            {sim.state === "incomplete" && <span style={{ color: "var(--ink-muted)" }}>{sim.reason}</span>}
          </span>
        )}
        {sim.state === "live" && <span style={{ flexBasis: "100%", order: 3, color: "var(--ink-muted)", fontSize: 12, lineHeight: "16px" }}>Settings lock until it finishes; Stop unlocks them.</span>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {(sim.state === "done" || canClear) && (
            <CtlButton variant="raised" type="button" onClick={onClear} style={{ ...btn, ...raisedButton, fontWeight: 500 }}><Broom size={14} weight="bold" aria-hidden="true" style={{ flex: "none" }} />Clear simulation</CtlButton>
          )}
          <SimulateButton disabled={off} onClick={onSimulate} />
        </span>
      </div>
    </div>
  );
}

// ---- sources ----
function SourcesCard({ sources }: { sources: string[] }) {
  const { inflows } = useExtras();
  const note = inflows?.properties?.note;
  return (
    <Card title="Sources">
      <ul style={{ margin: 0, padding: "10px 14px 12px", listStyle: "none", display: "flex", flexDirection: "column", gap: 7, fontSize: 13, lineHeight: "18px" }}>
        {sources.map((c, i) => <li key={i}>{c}</li>)}
        {inflows?.features.map((f) => (
          <li key={f.properties.name}>
            River inflow, {f.properties.name}
            {!!f.properties.gauges?.length && <span style={{ color: "var(--ink-muted)" }}> · gauge {f.properties.gauges.join(", ")}</span>}
          </li>
        ))}
        <li style={{ color: "var(--ink-muted)" }}>© OpenStreetMap contributors</li>
      </ul>
      {note && <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: "1px solid var(--hairline)", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>{note}</p>}
      <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: "1px solid var(--hairline)", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
        Built with Muse Spark Open. Not an operational warning system.
      </p>
    </Card>
  );
}

export function Sidebar({ aoi, run, scenario, sources, compare, onScenario, agent, agentMode = false, inspect, inspectAfter, inspectFocus, closeup = false, buildingsUrl, onDemo,
  tab: tabProp, onTab, phone = false, timeline }: {
  /** Phone and tablet: the shell owns the tab (the tab bar or the tour opens one); without it the sidebar keeps its own. */
  tab?: Tab; onTab?: (t: Tab) => void;
  /** In a phone sheet: no tab strip (the tab bar replaces it), Sources linked at the end of Layers, Simulate sticky at the bottom. */
  phone?: boolean;
  /** Tablet drawer: a Timeline tab with what the narrow dock leaves out (the third chart, key events). */
  timeline?: ReactNode;
  buildingsUrl?: string; onDemo?: () => Promise<void>;
  aoi?: AOIManifest; run?: RunManifest; scenario: ScenarioProps; sources: string[];
  /** Compare mode: the Compare tab's cards; Inspect then describes the run the map shows. */
  compare?: ReactNode; onScenario?: () => void;
  /** Agent mode: the Agent tab's content. It stays mounted on other tabs so a running session keeps streaming. */
  agent?: ReactNode; agentMode?: boolean;
  /** Replaces the Inspect tab (a selected building); `inspectAfter` is added below the usual cards. Inspect opens when `inspectFocus` changes. */
  inspect?: ReactNode; inspectAfter?: ReactNode; inspectFocus?: string;
  /** In a 3D close-up: Inspect opens (with `inspect` showing its cards) and the tab it left is restored afterwards. */
  closeup?: boolean;
}) {
  const [ownTab, setOwnTab] = useState<Tab>("Scenario");
  const tab = tabProp ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  const comparing = compare != null;
  // A mode change opens its tab. A shell that owns the tab is told only about a change, not the first render (no
  // sheet opens by itself; StrictMode runs effects twice, so this compares with the last mode seen).
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const now = comparing ? "Compare" : agentMode ? "Agent" : "Scenario";
    const before = seen.current;
    seen.current = now;
    if (onTab && (before === null || before === now)) return;
    setTab(now);
  }, [comparing, agentMode]);
  useEffect(() => { if (inspectFocus) setTab("Inspect"); }, [inspectFocus]);
  // The map chip's Details: Layers, scrolled to the Base map row with its pressed choice focused.
  const basemapFocus = useLayers().basemapFocus;
  useEffect(() => {
    if (!basemapFocus) return;
    setTab("Layers");
    // The Layers card may mount a few frames later (a lazy chunk, the phone sheet opening): look for the row for up to ~1 s.
    let tries = 0, raf = 0;
    const find = () => {
      const row = document.querySelector<HTMLElement>("[data-basemap-row]");
      const btn = row?.querySelector<HTMLElement>('button[aria-pressed="true"]');
      if (row && btn) { row.scrollIntoView({ block: "center" }); btn.focus(); return; }
      if (++tries < 60) raf = requestAnimationFrame(find);
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [basemapFocus]);
  const safeStart = useSafeRoute().origin;
  useEffect(() => { if (safeStart) setTab("Inspect"); }, [safeStart]);
  const obsSpot = useObsUi().spot;  // adding a photo of the water opens its card in Inspect
  useEffect(() => { if (obsSpot) setTab("Inspect"); }, [obsSpot?.seq]);  // eslint-disable-line react-hooks/exhaustive-deps
  // Closing an add card started from the Layers row: back to Layers, focus on that row's button (it mounts a few frames later).
  const layersBack = useObsUi().layersBack;
  useEffect(() => {
    if (!layersBack) return;
    setTab("Layers");
    let tries = 0, raf = 0;
    const find = () => {
      const b = document.querySelector<HTMLElement>("[data-obs-add]");
      if (b) { b.focus(); return; }
      if (++tries < 60) raf = requestAnimationFrame(find);
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [layersBack]);
  const before = useRef<Tab>("Scenario");
  const wasCloseup = useRef(false);
  useEffect(() => {
    if (closeup && !wasCloseup.current) { before.current = tab; setTab("Inspect"); }
    else if (!closeup && wasCloseup.current) setTab(before.current);
    wasCloseup.current = closeup;
  }, [closeup]);
  const { t_s } = useClock();
  // A sticky footer (the phone's Simulate bar, the Agent's Ask bar: [data-sticky-foot]) covers the bottom of the
  // scroller, so focus and scrollIntoView stop above it (otherwise a control scrolled into view lands under the footer
  // and a tap hits the footer). The visible one is followed as tabs and panels mount.
  const scroller = useRef<HTMLDivElement>(null);
  const [footH, setFootH] = useState(0);
  useLayoutEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    let el: HTMLElement | null = null, last = 0;
    // What it covers: its height, plus the gap its bottom offset leaves above the scroller's padded edge.
    const covers = (f: HTMLElement) => f.offsetHeight + (parseFloat(getComputedStyle(sc).paddingBottom) || 0) + (parseFloat(getComputedStyle(f).bottom) || 0);
    // The padding is written straight onto the scroller (React's copy follows), so a tap right after a tab switch or
    // the sheet opening already lands above the footer.
    const apply = (h: number) => { sc.style.scrollPaddingBottom = h ? `${h}px` : ""; setFootH(h); };
    // The visible footer: a closed phone sheet has none, and opening it resizes the scroller, which lands in measure.
    const visible = () => Array.from(sc.querySelectorAll<HTMLElement>("[data-sticky-foot]")).find((x) => x.offsetParent !== null) ?? null;
    const measure = () => {
      const f = visible();
      if (f !== el) {
        if (el) ro.unobserve(el);
        el = f;
        if (f) ro.observe(f, { box: "border-box" });  // padding counts (the safe-area inset)
        last = f ? covers(f) : 0;
        apply(last);
        return;
      }
      if (!el) return;
      const h = covers(el), grew = h - last;
      last = h;
      apply(h);
      // The footer grows when a status line wraps (the estimate arriving after a change): scroll by the growth, so
      // whatever sat just above the footer, touched or not, stays above it.
      if (grew > 0 && last > grew && sc.scrollTop > 0) sc.scrollTop += grew;
    };
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    measure();
    // A DOM change that swaps the footer (a tab switch) is measured at once; other changes re-measure at most once a frame.
    let frame = 0;
    const mo = new MutationObserver(() => {
      if (visible() !== el) { cancelAnimationFrame(frame); frame = 0; measure(); }
      else if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
    });
    mo.observe(sc, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(frame); };
  }, [phone, tab]);
  const locked = scenario.busy || scenario.sim.state === "running";
  // While it runs, the lock says why and for how long, so the greyed cards explain themselves.
  const sim = scenario.sim;
  const left = useEasedLeft(sim.state === "running" && sim.estS != null && sim.estS > 0 ? sim.estS - sim.elapsedS : null, sim.state === "running");
  const lockLabel = sim.state === "running" ? `Locked while simulating${left != null && left > 0 ? ` · ${minSec(left)} left` : ""}` : "Locked";
  const passM = typeof run?.stats?.passability_threshold_m === "number" ? run.stats.passability_threshold_m : 0.3;
  return (
    <aside style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", background: "var(--ground)", borderLeft: phone ? undefined : "1px solid var(--hairline)", minHeight: 0, overflow: "hidden" }}>
      {!phone && <Tabs tabs={[...(comparing ? COMPARE_TABS : agentMode ? AGENT_TABS : TABS), ...(timeline ? ["Timeline" as const] : [])]} active={tab} onTab={setTab} />}
      <div ref={scroller} style={{ flexGrow: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: 10, scrollPaddingBottom: footH || undefined }}>
        {tab === "Layers" && <><LayersCard aoiId={aoi?.aoi_id} runId={run?.run_id} /><FlowHazardCard /><GpuCard run={run} aoi={aoi} buildingsUrl={buildingsUrl} onDemo={onDemo} /></>}
        {tab === "Layers" && phone && (
          <CtlButton variant="text" type="button" onClick={() => setTab("Sources")} style={{ alignSelf: "flex-start", minHeight: 40, padding: "0 4px", background: "transparent", border: 0,
            color: "var(--ink-muted)", font: "inherit", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 3, cursor: "pointer" }}>Sources and credits</CtlButton>
        )}
        {tab === "Timeline" && timeline}
        {tab === "Inspect" && inspect}
        {tab === "Inspect" && !inspect && <><SafeRouteCard passM={passM} /><CursorCard tS={t_s} passM={passM} /><WaypointsCard /><OverviewCard run={run} aoi={aoi} passM={passM} onEdit={(comparing || agentMode) && onScenario ? onScenario : () => setTab("Scenario")} />{inspectAfter}</>}
        {tab === "Scenario" && (
          <>
            {scenario.linkNote && (
              <Notice message={scenario.linkNote.message} detail={scenario.linkNote.detail}>
                <Button onClick={scenario.linkNote.onDismiss}>Dismiss</Button>
              </Notice>
            )}
            <CardLock.Provider value={locked ? lockLabel : null}><StormCard {...scenario} /></CardLock.Provider>
            <CardLock.Provider value={locked ? lockLabel : null}>
              <div data-tour="rain" style={{ display: "flex", flexDirection: "column" }}><RainAreaCard hasInflows={!!aoi?.layers?.inflows} /></div>
            </CardLock.Provider>
            <RainPreviewCard />
            <CardLock.Provider value={locked ? lockLabel : null}>
              {scenario.coastal && <LevelCard level={scenario.level} onLevel={scenario.onLevel} aoiId={aoi?.aoi_id} />}
            </CardLock.Provider>
            <CardLock.Provider value={locked ? lockLabel : null}>
              {aoi?.drainage_default && <div data-tour="drainage" style={{ display: "flex", flexDirection: "column" }}><DrainageCard aoi={aoi} run={run} /></div>}
            </CardLock.Provider>
            {phone ? (
              <div data-sticky-foot="" style={{ position: "sticky", bottom: -10, zIndex: 2, margin: "0 -10px -10px", padding: "8px 10px calc(10px + env(safe-area-inset-bottom))", background: "var(--ground)",
                borderTop: "1px solid var(--hairline)", display: "flex", flexDirection: "column", order: 1 }}>
                <SimulateBar sim={scenario.sim} busy={scenario.busy} canRun={scenario.canRun} canClear={scenario.canClear} onSimulate={scenario.onSimulate} onStop={scenario.onStop} onClear={scenario.onClear} />
              </div>
            ) : <SimulateBar sim={scenario.sim} busy={scenario.busy} canRun={scenario.canRun} canClear={scenario.canClear} onSimulate={scenario.onSimulate} onStop={scenario.onStop} onClear={scenario.onClear} />}
            {scenario.err && (
              <Notice message={scenario.err.message}>
                {scenario.err.retryable && <Button disabled={scenario.busy} onClick={scenario.onSimulate}>Retry</Button>}
              </Notice>
            )}
          </>
        )}
        {tab === "Compare" && compare}
        {agent && <div style={{ display: (agentMode || phone) && tab === "Agent" ? "flex" : "none", flexDirection: "column", gap: 10, flexGrow: 1 }}>{agent}</div>}
        {tab === "Sources" && <SourcesCard sources={sources} />}
      </div>
    </aside>
  );
}
