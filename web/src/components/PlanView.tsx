// Plan view (rev 5 Plan.dc.html): select a building, read its depths, the place around it, and the
// depth series in the street cell beside it; map graticule and building popup in Plan.
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as Cesium from "cesium";
import { Copy, House, MapPin, RoadHorizon, Users } from "@phosphor-icons/react";
import { useTouch } from "../lib/breakpoint";
import { API, getPointSeries } from "../lib/api";
import type { AOIManifest, PointSeries, RunManifest } from "../lib/api";
import { clock, useClock } from "../lib/clock";
import { fmtT } from "./ds";
import { Band, Card, FIG, mono, raisedButton } from "./rev5";
import { DepthChart } from "./Dock";

type Ring = [number, number][];
type BuildingInfo = { id: string; ring: Ring; height_m: number | null; source: string | null; lon: number; lat: number };
const WET_M = 0.15, IMPASSABLE_M = 0.3, SEVERE_M = 0.5;

// ---- data ----
const indexCache = new Map<string, Promise<Map<string, BuildingInfo>>>();
/** id -> footprint, height and centroid, from the AOI's buildings GeoJSON (the file the map already loads). */
export function buildingIndex(url: string) {
  let p = indexCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => r.json()).then((fc) => {
      const m = new Map<string, BuildingInfo>();
      for (const f of fc.features ?? []) {
        const id = f.properties?.id, ring: Ring | undefined = f.geometry?.type === "Polygon" ? f.geometry.coordinates[0] : undefined;
        if (typeof id !== "string" || !ring?.length) continue;
        const lon = ring.reduce((a, q) => a + q[0], 0) / ring.length, lat = ring.reduce((a, q) => a + q[1], 0) / ring.length;
        m.set(id, { id, ring, lon, lat, height_m: typeof f.properties.height_m === "number" ? f.properties.height_m : null,
          source: typeof f.properties.height_source === "string" ? f.properties.height_source : null });
      }
      return m;
    });
    p.catch(() => indexCache.delete(url));
    indexCache.set(url, p);
  }
  return p;
}

export const inRing = (lon: number, lat: number, ring: Ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const placesCache = new Map<string, Promise<{ name: string; ring: Ring }[]>>();
export const placesOf = (aoiId: string) => {
  let p = placesCache.get(aoiId);
  if (!p) {
    p = fetch(`${API}/api/aoi/${aoiId}/layer/places`).then((r) => (r.ok ? r.json() : { features: [] }))
      .then((fc) => (fc.features ?? []).filter((f: any) => f.geometry?.type === "Polygon").map((f: any) => ({ name: f.properties.name, ring: f.geometry.coordinates[0] })))
      .catch(() => []);
    placesCache.set(aoiId, p);
  }
  return p;
};
const depthsCache = new Map<string, Promise<Map<string, number>>>();
const buildingDepths = (url: string) => {
  let p = depthsCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => r.json()).then((d) => new Map<string, number>((d.ids ?? []).map((id: string, i: number) => [String(id), d.max_depth_m[i]])));
    p.catch(() => depthsCache.delete(url));
    depthsCache.set(url, p);
  }
  return p;
};

export type Selected = {
  b: BuildingInfo; place: string | null;
  /** max depth in the 3x3 cells around the footprint (the flooded-building rule), from building_depths.json */
  near: number | null;
  own: PointSeries | null;
  /** the neighbouring cell with the deepest water: "the street beside it" */
  street: PointSeries | null;
};

/** Everything the cards, popup and dock show for one building in one run. */
export async function loadSelected(id: string, aoi: AOIManifest, buildingsUrl: string, run: RunManifest | undefined, runsBase: string): Promise<Selected | null> {
  const b = (await buildingIndex(buildingsUrl)).get(id);
  if (!b) return null;
  const place = (await placesOf(aoi.aoi_id)).find((p) => inRing(b.lon, b.lat, p.ring))?.name ?? null;
  if (!run || run.status !== "done") return { b, place, near: null, own: null, street: null };
  const near = run.building_depths ? (await buildingDepths(`${runsBase.replace(/\/$/, "")}/${run.run_id}/${run.building_depths}`).catch(() => null))?.get(id) ?? null : null;
  const [w, s, e, n] = aoi.grid.bounds_wgs84, dx = (e - w) / aoi.grid.nx, dy = (n - s) / aoi.grid.ny;
  const cells = [-1, 0, 1].flatMap((r) => [-1, 0, 1].map((c) => [b.lon + c * dx, b.lat + r * dy] as const));
  const series = await Promise.all(cells.map(([lo, la]) => getPointSeries(run.run_id, lo, la)));
  const own = series[4];
  const street = series.filter((x, i) => x && i !== 4 && !x.permanent_water).reduce<PointSeries | null>((m, x) => (!m || x!.max_depth_m > m.max_depth_m ? x : m), null);
  return { b, place, near, own, street };
}

// ---- formatting ----
const m2 = (v: number | null | undefined) => (v == null ? "n/a" : `${v.toFixed(2)} m`);
const dms = (v: number, pos: string, neg: string) => {
  const t = Math.round(Math.abs(v) * 3600), d = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;  // round once, so 59.6″ carries
  return `${d}°${String(m).padStart(2, "0")}′${String(s).padStart(2, "0")}″${v >= 0 ? pos : neg}`;
};
export const lonDms = (v: number) => dms(v, "E", "W");
export const latDms = (v: number) => dms(v, "N", "S");
const heightText = (b: BuildingInfo) => (b.height_m == null ? "n/a" : `${b.height_m} m${b.source ? ` · ${b.source === "2.5D" ? "Open Buildings 2.5D" : b.source}` : ""}`);
const counted = (near: number | null) => near == null ? "n/a" : near >= SEVERE_M ? `Severely flooded (≥ ${SEVERE_M.toFixed(1)} m, 3×3 rule)`
  : near >= WET_M ? `Flooded (≥ ${WET_M.toFixed(2)} m, 3×3 rule)` : `Not flooded (under ${WET_M.toFixed(2)} m, 3×3 rule)`;

// ---- sidebar ----
export function SelectedBuildingCard({ sel, second, onFly, onClear }: { sel: Selected; second?: Selected | null; onFly: () => void; onClear: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const u = new URL(window.location.href); u.searchParams.set("building", sel.b.id);
    navigator.clipboard?.writeText(u.toString()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };
  const own = sel.own?.max_depth_m ?? null;
  const rows: [string, ReactNode][] = [
    ["Plus code", <span style={{ fontFamily: mono, fontSize: 12 }}>{sel.b.id}</span>],
    ["Place", sel.place ?? "Outside named places"],
    ["Height", heightText(sel.b)],
    ["At or next to it", <><span style={{ color: sel.near != null && sel.near >= WET_M ? "var(--hazard)" : undefined, fontWeight: 600, ...FIG }}>{m2(sel.near)}</span> run max</>],
    ["On its own cell", <span style={FIG}>{m2(own)}</span>],
    ["Counted as", counted(sel.near)],
  ];
  return (
    <Card title="Selected building" right={<button type="button" onClick={onClear} style={{ marginLeft: "auto", padding: "3px 6px", border: 0, background: "transparent", color: "var(--ink-muted)", font: "inherit", fontSize: 12 }}>Clear</button>}>
      <dl style={{ margin: 0, padding: "10px 14px 12px", display: "grid", gridTemplateColumns: "112px minmax(0, 1fr)", rowGap: 7, columnGap: 10, fontSize: 13, lineHeight: "18px" }}>
        {rows.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt style={{ color: "var(--ink-muted)" }}>{k}</dt><dd style={{ margin: 0, minWidth: 0 }}>{v}</dd></div>)}
      </dl>
      <div style={{ display: "flex", gap: 8, padding: "0 14px 12px" }}>
        <button type="button" onClick={onFly} style={{ height: 30, display: "flex", alignItems: "center", gap: 6, padding: "0 10px", ...raisedButton, borderRadius: "var(--radius-md)", font: "inherit", fontSize: 13 }}><MapPin size={14} weight="bold" />Fly to</button>
        <button type="button" onClick={copy} style={{ height: 30, display: "flex", alignItems: "center", gap: 6, padding: "0 10px", border: 0, background: "transparent", color: "var(--ink-muted)", font: "inherit", fontSize: 13 }}><Copy size={14} weight="bold" />{copied ? "Copied" : "Copy link"}</button>
      </div>
      {second && (
        <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: "1px solid var(--hairline)", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
          Comparing with <span style={{ fontFamily: mono, fontSize: 11 }}>{second.b.id}</span>: <span style={FIG}>{m2(second.near)}</span> at or next to it (dashed in the chart).
        </p>
      )}
    </Card>
  );
}

export function PlaceCard({ place, runId }: { place: string; runId?: string }) {
  const [a, setA] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    setA(null);
    if (!runId) return;
    let off = false;
    fetch(`${API}/api/runs/${runId}/area?place=${encodeURIComponent(place)}`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (!off) setA(d); }).catch(() => {});
    return () => { off = true; };
  }, [place, runId]);
  const cell = (Ic: typeof House, label: string, v: string, color?: string, border = true) => (
    <div style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr)", columnGap: 8, padding: "10px 12px", borderLeft: border ? "1px solid var(--hairline)" : undefined }}>
      <span style={{ color: "var(--ink-muted)", paddingTop: 1 }}><Ic size={16} weight="bold" /></span>
      <span style={{ display: "flex", flexDirection: "column" }}><span style={{ color: "var(--ink-muted)", fontSize: 12 }}>{label}</span>
        <span style={{ fontSize: 16, lineHeight: "22px", fontWeight: 600, color, ...FIG }}>{v}</span></span>
    </div>
  );
  return (
    <Card title={place} right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>Place · run max</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        {cell(House, "Buildings", a ? a.buildings_flooded.toLocaleString("en-GB") : "…", undefined, false)}
        {cell(RoadHorizon, "Road km", a ? a.road_km_impassable.toFixed(1) : "…", "var(--hazard)")}
        {cell(Users, "People", a ? a.people_exposed.toLocaleString("en-GB") : "…")}
      </div>
      <p style={{ margin: 0, padding: "8px 14px 10px", borderTop: "1px solid var(--hairline)", color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
        Run max inside the place. The planner cites the same numbers.
      </p>
    </Card>
  );
}

export function HowToInspectCard() {
  const touch = useTouch();
  return (
    <Card title="How to inspect">
      <p style={{ margin: 0, padding: "10px 14px 12px", color: "var(--ink-muted)", fontSize: 13, lineHeight: "19px" }}>
        {touch ? "Tap the map to pin the depth at that point, or in Plan view tap a building to select it here."
          : "Hover the map for depth at the cursor. Click a point to pin it, or in Plan view click a building to select it here. Shift-click a second building to compare."}
      </p>
    </Card>
  );
}

// ---- map ----
const screen = (v: Cesium.Viewer, lon: number, lat: number) => v.scene.cartesianToCanvasCoordinates(Cesium.Cartesian3.fromDegrees(lon, lat));
const useFrame = (v?: Cesium.Viewer) => {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!v || v.isDestroyed()) return;
    let raf = 0;
    const rm = v.scene.postRender.addEventListener(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; tick((n) => n + 1); }); });
    return () => { rm(); cancelAnimationFrame(raf); };
  }, [v]);
};

const STEPS_S = [1, 2, 3, 5, 6, 10, 12, 15, 18, 20, 30, 36, 60, 120, 180, 300, 600];
/** Plan view: lon labels along the bottom, lat labels on the right, faint lines between. */
export function Graticule({ viewer }: { viewer?: Cesium.Viewer }) {
  useFrame(viewer);
  if (!viewer || viewer.isDestroyed()) return null;
  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return null;
  const [w, s, e, n] = [rect.west, rect.south, rect.east, rect.north].map(Cesium.Math.toDegrees);
  const stepFor = (span: number) => (STEPS_S.find((k) => (span * 3600) / k <= 4) ?? 600) / 3600;
  const ticks = (a: number, b: number, st: number) => { const out: number[] = []; for (let v = Math.ceil(a / st) * st; v <= b; v += st) out.push(+v.toFixed(8)); return out; };
  const cw = viewer.canvas.clientWidth, ch = viewer.canvas.clientHeight;
  const midLat = (s + n) / 2, midLon = (w + e) / 2;
  const lab = { position: "absolute" as const, padding: "2px 6px", background: "color-mix(in srgb, var(--ground) 82%, transparent)", border: "1px solid var(--hairline)", borderRadius: 3,
    fontFamily: mono, fontSize: 11, color: "var(--ink)", whiteSpace: "nowrap" as const };
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
      {ticks(w, e, stepFor(e - w)).map((lon) => {
        const p = screen(viewer, lon, midLat); if (!p || p.x < 40 || p.x > cw - 40) return null;
        return <div key={`x${lon}`}><span style={{ position: "absolute", left: p.x, top: 0, bottom: 0, width: 1, background: "var(--ink)", opacity: 0.12 }} />
          <span style={{ ...lab, left: p.x, bottom: 92, transform: "translateX(-50%)" }}>{lonDms(lon)}</span></div>;
      })}
      {ticks(s, n, stepFor(n - s)).map((lat) => {
        const p = screen(viewer, midLon, lat); if (!p || p.y < 70 || p.y > ch - 120) return null;
        return <div key={`y${lat}`}><span style={{ position: "absolute", top: p.y, left: 0, right: 0, height: 1, background: "var(--ink)", opacity: 0.12 }} />
          <span style={{ ...lab, top: p.y, right: 12, transform: "translateY(-50%)" }}>{latDms(lat)}</span></div>;
      })}
    </div>
  );
}

/** Danfo outline round the selected footprint(s) and the popup next to the primary one. */
export function BuildingOnMap({ viewer, sel, second }: { viewer?: Cesium.Viewer; sel: Selected; second?: Selected | null }) {
  useFrame(viewer);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const css = getComputedStyle(document.documentElement);
    const col = (name: string) => Cesium.Color.fromCssColorString(css.getPropertyValue(name).trim() || "#f5b800");
    const add = (b: BuildingInfo, name: string, dashed: boolean) => viewer.entities.add({ polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([...b.ring, b.ring[0]].flat()), width: 3, clampToGround: true,
      material: dashed ? new Cesium.PolylineDashMaterialProperty({ color: col(name) }) : col(name) } });
    const ents = [add(sel.b, "--danfo", false), ...(second ? [add(second.b, "--danfo", true)] : [])];
    return () => { if (!viewer.isDestroyed()) ents.forEach((x) => viewer.entities.remove(x)); };
  }, [viewer, sel.b.id, second?.b.id]);
  if (!viewer || viewer.isDestroyed()) return null;
  const p = screen(viewer, sel.b.lon, sel.b.lat);
  if (!p) return null;
  const cut = sel.street?.first_impassable_s;
  return (
    <div style={{ position: "absolute", left: p.x, top: p.y - 24, transform: "translate(-50%, -100%)", zIndex: 1, minWidth: 300, maxWidth: 360, background: "var(--surface-raised)",
      border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", pointerEvents: "none" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 12px" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}><House size={15} weight="bold" /><span style={{ fontWeight: 600 }}>Building</span>
          <span style={{ marginLeft: "auto", fontFamily: mono, fontSize: 11, color: "var(--ink-muted)" }}>{sel.b.id}</span></span>
        <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}><span style={{ fontSize: 18, fontWeight: 700, color: sel.near != null && sel.near >= WET_M ? "var(--hazard)" : "var(--ink)", ...FIG }}>{m2(sel.near)}</span>
          <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>at or next to it, run max</span></span>
      </div>
      <p style={{ margin: 0, padding: "7px 12px 9px", borderTop: "1px solid var(--hairline)", fontSize: 12, lineHeight: "17px", color: "var(--ink-muted)" }}>
        <span style={{ color: "var(--ink)", ...FIG }}>{m2(sel.own?.max_depth_m)}</span> on its own cell · street beside it {cut != null ? <>impassable from <span style={{ color: "var(--ink)", ...FIG }}>{fmtT(cut)}</span></> : "never impassable"}
      </p>
    </div>
  );
}

// ---- dock ----
type Row = { label: string; t: number };
/** Dock while a building is selected: depth in the street cell beside it, with its key moments. */
export function BuildingDock({ sel, second }: { sel: Selected; second?: Selected | null }) {
  const { t_s } = useClock();
  const st = sel.street ?? sel.own;
  const rows = useMemo<Row[]>(() => {
    if (!st) return [];
    const out: Row[] = [];
    if (st.first_flooded_s != null) out.push({ label: `Flooded, ${st.threshold_m.flooded.toFixed(2)} m`, t: st.first_flooded_s });
    if (st.first_impassable_s != null) out.push({ label: `Impassable, ${st.threshold_m.road_impassable.toFixed(2)} m`, t: st.first_impassable_s });
    const i = st.depth_m.indexOf(Math.max(...st.depth_m));
    if (i >= 0) out.push({ label: `Deepest, ${st.depth_m[i].toFixed(2)} m`, t: st.t_s[i] });
    out.push({ label: `Still ${st.depth_m[st.depth_m.length - 1].toFixed(2)} m`, t: st.t_s[st.t_s.length - 1] });
    return out.sort((a, b) => a.t - b.t);
  }, [st]);
  const active = [...rows].reverse().find((r) => r.t <= t_s);
  const step = st && st.t_s.length > 1 ? Math.round((st.t_s[1] - st.t_s[0]) / 60) : 0;
  const ghost = second ? (second.street ?? second.own)?.depth_m : undefined;
  return (
    <div data-tour="timeline" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", background: "var(--surface)", borderTop: "1px solid var(--hairline)", minHeight: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Band title="Depth beside the selected building" right={st && <span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12, whiteSpace: "nowrap" }}>
          {sel.street ? "street cell" : "its own cell"} <span style={{ fontFamily: mono, fontSize: 11 }}>{latDms(st.cell_center[1])} {lonDms(st.cell_center[0])}</span> · {step}-min frames{second ? " · dashed: second building" : ""}</span>} />
        {st ? <DepthChart series={st.depth_m} ts={st.t_s} ghost={ghost} threshold={[st.threshold_m.road_impassable, `Impassable ${st.threshold_m.road_impassable.toFixed(2)} m (assumption)`]} />
          : <p style={{ margin: 0, padding: 18, color: "var(--ink-muted)" }}>{sel.own === null && sel.street === null ? "Run a simulation to see depth beside this building." : "Loading depth…"}</p>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid var(--hairline)", minHeight: 0 }}>
        <Band title="At this cell" />
        <ol style={{ margin: "4px 0 0", padding: 0, listStyle: "none" }}>
          {rows.map((r) => {
            const on = r === active, fut = r.t > t_s;
            return (
              <li key={r.label} onClick={() => clock.set({ t_s: r.t, playing: false })}
                style={{ display: "flex", alignItems: "center", height: 34, padding: "0 12px 0 14px", cursor: "pointer", ...(fut ? { color: "var(--ink-muted)" } : {}),
                  ...(on ? { background: "var(--surface-raised)", boxShadow: "inset 3px 0 0 var(--danfo), inset 0 1px 0 var(--elev-hi)", fontWeight: 600 } : {}) }}>
                {r.label}<span style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-muted)", fontWeight: 400, ...FIG }}>{fmtT(r.t)}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
