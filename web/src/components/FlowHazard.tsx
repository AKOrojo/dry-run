// Flow and hazard (design board 9): the Layers card, flow arrows, the AIDR hazard drape, loads on buildings (map chips and the
// dock's side panel) and the depth profile along a drawn line. Data and the shared store live in lib/flowhazard.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import * as Cesium from "cesium";
import { Wind } from "@phosphor-icons/react";
import { API } from "../lib/api";
import type { AOIManifest, RunManifest } from "../lib/api";
import { useLayers, setLayer } from "../lib/layers";
import { setFocus } from "../lib/focus";
import { useClock } from "../lib/clock";
import { decodePng } from "../lib/patch3d";
import {
  flowStore, getHazardLegend, getLoads, getVelocityFrame, getVelocityManifest, hazardClass, HAZARD_CAPTION, LOADS_LABEL, metres, nearestFrame, profileAt,
  requestBuilding, sampleProfile, useFlowHazard,
} from "../lib/flowhazard";
import type { HazardLegend, LL, LoadRow, VelocityManifest } from "../lib/flowhazard";
import { Anchored } from "./Anchored";
import type { Anchors } from "./Anchored";
import { buildingIndex, inRing, placesOf } from "./PlanView";
import { Switch as Toggle } from "./controls/Switch";
import { Band, Card, FIG, raisedButton } from "./rev5";
import { fmtT } from "./ds";

/** The ground point under a canvas pixel: the globe (terrain or the 3D tiles), else the ellipsoid where no tile has loaded. */
function pickGround(viewer: Cesium.Viewer, x: number, y: number): Cesium.Cartesian3 | undefined {
  const pos = new Cesium.Cartesian2(x, y);
  return viewer.scene.globe.pick(viewer.camera.getPickRay(pos) as Cesium.Ray, viewer.scene) ?? viewer.camera.pickEllipsoid(pos, viewer.scene.globe.ellipsoid);
}
const cssColor = (name: string) => Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
/** The legend's scale: an arrow for 1 m/s is this long on screen, at every zoom. */
export const FLOW_PX_PER_MS = 60;
const MIN_SPEED = 0.05;
/** Arrows stay between these lengths on screen: the shortest still shows its head, the longest does not run into its neighbours. */
const MIN_ARROW_PX = 16;
const MAX_ARROW_PX = 72;
const AERIAL_LIFT_M = 40;
// Photoreal hides the globe, so its terrain heights are coarse and sit metres under the 3D tiles; 15 m clears the street
// surface and stays under most roofs (arrows behind buildings still show, dimmer, through depthFailAppearance).
const PHOTOREAL_LIFT_M = 15;
/** Chips go on buildings carrying at least this much per metre of wall (top N of them). */
const CHIP_MIN_KNM = 10;
const CHIP_MAX = 60;
const LIST_MAX = 150;

// ============================================================ the sidebar card
export function FlowHazardCard() {
  const lay = useLayers();
  const fh = useFlowHazard();
  const rows: { key: "flow" | "hazard" | "loads"; label: string; note: string }[] = [
    { key: "flow", label: "Flow arrows", note: "speed and direction" },
    { key: "hazard", label: "Flood hazard", note: "AIDR H1–H6" },
    { key: "loads", label: "Loads on buildings", note: "screening values" },
  ];
  const draw = () => { setLayer("profile", { on: true }); flowStore.set({ drawing: "a" }); };
  return (
    <div data-tour="flow" style={{ display: "flex", flexDirection: "column" }}>
      <Card title="Flow and hazard" right={<Wind size={16} weight="bold" color="var(--ink-muted)" style={{ marginLeft: "auto" }} aria-hidden="true" />}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 14px 12px" }}>
          {rows.map((r) => (
            <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 22 }}>
              <Toggle on={lay[r.key].on} label={r.label} onChange={(on) => setLayer(r.key, { on })} />
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-muted)" }}>{r.note}</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 30 }}>
            <Toggle on={lay.profile.on} label="Depth profile" onChange={(on) => { setLayer("profile", { on }); if (!on) flowStore.set({ drawing: null }); }} />
            <button type="button" onClick={draw} aria-pressed={!!fh.drawing}
              style={{ marginLeft: "auto", height: 30, display: "flex", alignItems: "center", gap: 7, padding: "0 12px", ...raisedButton, borderRadius: "var(--radius-md)", font: "inherit", cursor: "pointer",
                ...(fh.drawing ? { outline: "var(--stroke-focus) solid var(--danfo)", outlineOffset: -1 } : {}) }}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 11 L12 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" /><circle cx="2.5" cy="10.5" r="1.8" fill="currentColor" /><circle cx="11.5" cy="3.5" r="1.8" fill="currentColor" /></svg>
              {fh.drawing ? "Click the map" : fh.a && fh.b ? "Redraw" : "Draw a line"}</button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ============================================================ the legend (one slot with the other bottom-left legends)
const SWATCH_ALPHA = [0, 0.2, 0.36, 0.52, 0.76, 1];
export function FlowLegend({ runId }: { runId?: string }) {
  const lay = useLayers();
  const [legend, setLegend] = useState<HazardLegend | null>(null);
  const hazardOn = lay.hazard.on, flowOn = lay.flow.on;
  useEffect(() => {
    setLegend(null);
    if (!runId || !hazardOn) return;
    let off = false;
    getHazardLegend(runId).then((l) => { if (!off) setLegend(l); });
    return () => { off = true; };
  }, [runId, hazardOn]);
  if (!runId || (!hazardOn && !flowOn)) return null;
  const alphas = legend?.classes.map((c) => c.alpha) ?? SWATCH_ALPHA;
  return (
    <div className="ft-legend" style={{ pointerEvents: "none", boxShadow: "var(--shadow-float)", gap: 6 }}>
      {hazardOn && (
        <>
          <span style={{ fontSize: 13, lineHeight: "18px", fontWeight: 600 }}>Flood hazard (AIDR)</span>
          <div style={{ display: "flex", gap: 2 }}>
            {alphas.map((a, i) => (
              <span key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 26 }}>
                <span style={{ width: 26, height: 10, border: "var(--stroke-hairline) solid var(--hairline)", borderRadius: 2, background: `color-mix(in srgb, var(--hazard) ${Math.round(a * 100)}%, transparent)` }} />
                <span style={{ fontSize: 11, lineHeight: "14px", color: "var(--ink-muted)", ...FIG }}>H{i + 1}</span>
              </span>
            ))}
          </div>
          <span className="ft-legend-note">{HAZARD_CAPTION}</span>
        </>
      )}
      {flowOn && (
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, lineHeight: "16px", color: "var(--ink-muted)", whiteSpace: "nowrap", ...(hazardOn ? { paddingTop: 2 } : {}) }}>
          <svg width={FLOW_PX_PER_MS} height="10" viewBox={`0 0 ${FLOW_PX_PER_MS} 10`} aria-hidden="true"><line x1="0" y1="5" x2={FLOW_PX_PER_MS - 3} y2="5" stroke="var(--ink)" strokeWidth="2" /><path d={`M${FLOW_PX_PER_MS} 5 L${FLOW_PX_PER_MS - 8} 1 L${FLOW_PX_PER_MS - 8} 9 Z`} fill="var(--ink)" /></svg>
          flow 1 m/s · estimated from the water surface
        </span>
      )}
    </div>
  );
}

// ============================================================ the map layers
type MapProps = {
  viewer?: Cesium.Viewer; scene?: Cesium.Scene; anchors: React.MutableRefObject<Anchors>; aoi?: AOIManifest; run?: RunManifest; tS: number;
  basemap: "aerial" | "photoreal"; frames?: { t_s: number; url: string }[]; buildingsUrl?: string; onBuilding?: (id: string, shift: boolean) => void;
};

/** Everything board 9 draws on the map. Renders chips and handles (DOM, anchored) and owns the Cesium primitives. */
export function FlowHazardMap(p: MapProps) {
  const lay = useLayers();
  const runId = p.run?.status === "done" ? p.run.run_id : undefined;
  return (
    <>
      {p.viewer && runId && lay.flow.on && <Arrows {...p} viewer={p.viewer} runId={runId} />}
      {p.viewer && runId && lay.hazard.on && <HazardDrape viewer={p.viewer} runId={runId} aoi={p.aoi} basemap={p.basemap} />}
      {runId && lay.loads.on && <LoadChips {...p} runId={runId} />}
      <ProfileMap {...p} runId={runId} />
    </>
  );
}

// ---------------------------------------------------------------- flow arrows
/** Metres per CSS pixel at the middle of the view, plus where the view is centred: the arrows' zoom and pan key. */
function useCameraKey(viewer: Cesium.Viewer, spacingM: number) {
  const [key, setKey] = useState("");
  const info = useRef({ mpp: 1 });
  useEffect(() => {
    const s = viewer.scene, c = viewer.camera;
    let last = 0;
    const probe = () => {
      if (s.isDestroyed()) return;
      const now = performance.now();
      if (now - last < 150) return;
      last = now;
      const w = s.canvas.clientWidth, h = s.canvas.clientHeight;
      if (!w || !h) return;
      const hit = pickGround(viewer, w / 2, h / 2);
      if (!hit) return;
      const mpp = c.getPixelSize(new Cesium.BoundingSphere(hit, 1), w, h);
      if (!(mpp > 0)) return;
      info.current.mpp = mpp;
      const cg = Cesium.Cartographic.fromCartesian(hit);
      const zoom = Math.round(Math.log2(mpp) * 2);  // half-octave steps
      const q = Math.max(spacingM, mpp * Math.max(w, h) * 0.3);  // rebuild when the view centre has moved a third of a screen
      const dLat = q / 110540;
      setKey(`${zoom}|${Math.round(Cesium.Math.toDegrees(cg.longitude) / (dLat / Math.cos(cg.latitude)))}|${Math.round(Cesium.Math.toDegrees(cg.latitude) / dLat)}`);
    };
    s.postRender.addEventListener(probe);
    probe();
    return () => { if (!s.isDestroyed()) s.postRender.removeEventListener(probe); };
  }, [viewer, spacingM]);
  return { key, info };
}

const ALPHA_LEVELS = [0.55, 0.7, 0.85, 1];
/** Mid-depth by water-frame bin (the alpha of engine.depth_png's colour map): only used to lift arrows to the water surface on Photoreal. */
const depthOfAlpha = (a: number) => (a < 100 ? 0 : a < 140 ? 0.1 : a < 175 ? 0.225 : a < 200 ? 0.4 : a < 220 ? 0.75 : a < 238 ? 1.5 : 2.5);

function Arrows({ viewer, runId, tS, basemap, frames }: MapProps & { viewer: Cesium.Viewer; runId: string }) {
  const [man, setMan] = useState<VelocityManifest | null>(null);
  useEffect(() => {
    setMan(null);
    let off = false;
    getVelocityManifest(runId).then((m) => { if (!off) setMan(m); });
    return () => { off = true; };
  }, [runId]);
  const fi = man ? nearestFrame(man.frames.map((f) => f.t_s), tS) : 0;
  const { key: camKey, info } = useCameraKey(viewer, man?.block_m ?? 100);
  const heights = useRef(new Map<string, number>());
  useEffect(() => { heights.current.clear(); }, [runId, basemap]);
  // Warm the next frames while the playhead moves.
  useEffect(() => {
    if (!man) return;
    for (const k of [fi + 1, fi + 2]) if (k < man.frames.length) getVelocityFrame(runId, k, man).catch(() => {});
  }, [man, runId, fi]);

  useEffect(() => {
    if (!man || !camKey || viewer.isDestroyed()) return;
    let live = true;
    const scene = viewer.scene;
    const water = basemap === "photoreal" && frames?.length ? frames[nearestFrame(frames.map((f) => f.t_s), tS)] : undefined;
    Promise.all([getVelocityFrame(runId, fi, man), water ? decodePng(water.url).catch(() => null) : Promise.resolve(null)]).then(([fr, wimg]) => {
      if (!live || viewer.isDestroyed()) return;
      const mpp = info.current.mpp, [w, s, e, n] = man.bounds_wgs84;
      const bpx = man.block_m / mpp;
      const stride = Math.max(1, Math.round(32 / bpx));  // arrows ~24-40 px apart
      // Ink arrows, more opaque the faster the water. No dark halo: PolylineArrow is always translucent, so a halo at the same
      // depth blended into the arrow and turned it grey (invisible on dark streets).
      const mats = ALPHA_LEVELS.map((a) => Cesium.Material.fromType("PolylineArrow", { color: cssColor("--ink").withAlpha(0.75 + a * 0.25) }));
      // One shared material per opacity level, plus a dark underlay so white arrows read on light imagery too.
      const byLevel: Cesium.GeometryInstance[][] = ALPHA_LEVELS.map(() => []);
      const seg = (a: Cesium.Cartesian3, b: Cesium.Cartesian3, width: number) => new Cesium.GeometryInstance({ geometry: new Cesium.PolylineGeometry({
        positions: [a, b], width, arcType: Cesium.ArcType.NONE, vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT }) });
      const view = viewer.camera.computeViewRectangle();
      const grow = view ? Math.max(view.width, view.height) * 0.25 : 0;
      const bw = (e - w) / fr.nx, bh = (n - s) / fr.ny;
      // First pass: one arrow per block of cells in and near the view.
      const pts: { lon: number; lat: number; hk: string; speed: number; ux: number; uy: number }[] = [];
      for (let j0 = 0; j0 < fr.ny && pts.length < 4500; j0 += stride) {
        for (let i0 = 0; i0 < fr.nx && pts.length < 4500; i0 += stride) {
          let su = 0, sv = 0, ss = 0, nw = 0, nc = 0;
          for (let j = j0; j < Math.min(fr.ny, j0 + stride); j++) for (let i = i0; i < Math.min(fr.nx, i0 + stride); i++) {
            nc++;
            const k = j * fr.nx + i;
            if (fr.wet[k]) { nw++; su += fr.u[k]; sv += fr.v[k]; ss += fr.speed[k]; }
          }
          if (nw * 4 < nc) continue;  // mostly dry: no arrow (a quarter wet keeps street-only flooding)
          const speed = ss / nw;
          if (speed < MIN_SPEED) continue;
          const mag = Math.hypot(su, sv) / nw;
          if (!(mag > 0)) continue;
          const ci = Math.min(fr.nx, i0 + stride / 2), cj = Math.min(fr.ny, j0 + stride / 2);
          const lon = w + ci * bw, lat = n - cj * bh;
          if (view && (lon < Cesium.Math.toDegrees(view.west) - Cesium.Math.toDegrees(grow) || lon > Cesium.Math.toDegrees(view.east) + Cesium.Math.toDegrees(grow)
            || lat < Cesium.Math.toDegrees(view.south) - Cesium.Math.toDegrees(grow) || lat > Cesium.Math.toDegrees(view.north) + Cesium.Math.toDegrees(grow))) continue;
          pts.push({ lon, lat, hk: `${stride}|${i0}|${j0}`, speed, ux: su / (mag * nw), uy: sv / (mag * nw) });
        }
      }
      // Ground under each arrow, cached per block: the terrain height. The globe still answers on Photoreal, where it is hidden;
      // sampling the 3D tiles instead waits on tile loading and hits cloud billboards and roofs.
      for (const q of pts) if (!heights.current.has(q.hk)) {
        const g = scene.globe.getHeight(Cesium.Cartographic.fromDegrees(q.lon, q.lat));
        if (g !== undefined) heights.current.set(q.hk, g);
      }
      const fr0 = viewer.camera.frustum as Cesium.PerspectiveFrustum;
      // Pixels per metre of distance: 1 px covers distance * 2 tan(fovy / 2) / canvas height metres.
      const pxPerM = fr0.fovy ? scene.canvas.clientHeight / (2 * Math.tan(fr0.fovy / 2)) : 0;
      let count = 0;
      for (const q of pts) {
          const { lon, lat, speed, ux, uy } = q;
          const h = heights.current.get(q.hk);
          if (h === undefined) continue;  // no ground known yet: skip rather than draw it under the tiles
          // Photoreal: ride on the water surface (ground + depth); Aerial: just above the terrain.
          let depth = 0;
          if (wimg) depth = depthOfAlpha(wimg.rgba[(Math.min(wimg.h - 1, Math.floor(((n - lat) / (n - s)) * wimg.h)) * wimg.w + Math.min(wimg.w - 1, Math.floor(((lon - w) / (e - w)) * wimg.w))) * 4 + 3]);
          // Photoreal: on the water surface (ground + depth). Aerial: above the roofs of the extruded buildings, which would otherwise hide them.
          const z = h + depth + (basemap === "photoreal" ? PHOTOREAL_LIFT_M : AERIAL_LIFT_M);
          // Metres per pixel at this arrow, not the screen centre: in a tilted view far arrows would shrink to a few pixels.
          const here = Cesium.Cartesian3.fromDegrees(lon, lat, z);
          const mppHere = pxPerM > 0 ? Cesium.Cartesian3.distance(viewer.camera.positionWC, here) / pxPerM : mpp;
          const lenM = Math.min(Math.max(speed * FLOW_PX_PER_MS, MIN_ARROW_PX), MAX_ARROW_PX) * mppHere;
          const half = lenM / 2;
          const lat0 = Cesium.Math.toRadians(lat);
          const a = Cesium.Cartesian3.fromDegrees(lon - (ux * half) / (111320 * Math.cos(lat0)), lat - (uy * half) / 110540, z);
          const b = Cesium.Cartesian3.fromDegrees(lon + (ux * half) / (111320 * Math.cos(lat0)), lat + (uy * half) / 110540, z);
          const level = Math.min(ALPHA_LEVELS.length - 1, Math.floor((speed / Math.max(man.vmax_m_s, 0.5)) * ALPHA_LEVELS.length));
          byLevel[level].push(seg(a, b, 8));
          count++;
      }
      // Primitives rather than a PolylineCollection, for depthFailAppearance: under buildings or the 3D tiles (the terrain
      // under hidden-globe Photoreal is coarse) an arrow still shows, dimmer, instead of vanishing.
      const col = new Cesium.PrimitiveCollection();
      const prim = (insts: Cesium.GeometryInstance[], appearance: Cesium.Appearance, depthFailAppearance?: Cesium.Appearance) => {
        if (insts.length) col.add(new Cesium.Primitive({ geometryInstances: insts, asynchronous: false, appearance, depthFailAppearance }));
      };
      byLevel.forEach((g, i) => prim(g, new Cesium.PolylineMaterialAppearance({ material: mats[i] }),
        new Cesium.PolylineMaterialAppearance({ material: Cesium.Material.fromType("PolylineArrow", { color: (mats[i].uniforms.color as Cesium.Color).withAlpha(0.45) }) })));
      scene.primitives.add(col);
      if (import.meta.env.DEV) console.info(`flow arrows: ${count} at frame ${fi}, stride ${stride}, ${mpp.toFixed(1)} m/px, peak ${man.peak_speed_m_s} m/s`);
      if (prevRef.current && !prevRef.current.isDestroyed()) scene.primitives.remove(prevRef.current);
      prevRef.current = col;
      scene.requestRender();  // the scene renders on demand
    }).catch(() => { /* frame unavailable: keep the arrows already drawn */ });
    return () => { live = false; };
  }, [man, fi, camKey, runId, basemap, viewer]);  // eslint-disable-line react-hooks/exhaustive-deps
  const prevRef = useRef<Cesium.PrimitiveCollection>();
  useEffect(() => () => {
    if (!viewer.isDestroyed() && prevRef.current && !prevRef.current.isDestroyed()) { viewer.scene.primitives.remove(prevRef.current); viewer.scene.requestRender(); }
    prevRef.current = undefined;
  }, [viewer]);
  return null;
}

// ---------------------------------------------------------------- hazard drape
function HazardDrape({ viewer, runId, aoi, basemap }: { viewer: Cesium.Viewer; runId: string; aoi?: AOIManifest; basemap: "aerial" | "photoreal" }) {
  const bounds = aoi?.grid.bounds_wgs84;
  const bkey = bounds?.join(",");
  useEffect(() => {
    if (!bounds || viewer.isDestroyed()) return;
    const rect = Cesium.Rectangle.fromDegrees(...bounds);
    let cancelled = false;
    let remove: () => void = () => {};
    // The PNG sits behind a redirect to the public bucket: fetch it (the bucket allows CORS) and hand the map a same-origin blob, so WebGL can use it.
    fetch(`${API}/api/runs/${runId}/derived/hazard.png`).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status))))).then(async (blob) => {
      if (cancelled || viewer.isDestroyed()) return;
      const url = URL.createObjectURL(blob);
      if (basemap === "aerial") {
        const pr = await Cesium.SingleTileImageryProvider.fromUrl(url, { rectangle: rect });
        if (cancelled || viewer.isDestroyed()) { URL.revokeObjectURL(url); return; }
        const layer = viewer.imageryLayers.addImageryProvider(pr);
        viewer.scene.requestRender();
        remove = () => { if (!viewer.isDestroyed()) { viewer.imageryLayers.remove(layer, true); viewer.scene.requestRender(); } URL.revokeObjectURL(url); };
      } else {
        // Photoreal: a textured ground primitive classifying the 3D tiles, as the water is draped.
        const prim = new Cesium.GroundPrimitive({
          geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.RectangleGeometry({ rectangle: rect, vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat }) }),
          appearance: new Cesium.MaterialAppearance({ material: Cesium.Material.fromType("Image", { image: url, color: Cesium.Color.WHITE }), flat: true, translucent: true }),
          classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        });
        viewer.scene.groundPrimitives.add(prim);
        viewer.scene.requestRender();
        remove = () => { if (!viewer.isDestroyed() && !prim.isDestroyed()) { viewer.scene.groundPrimitives.remove(prim); viewer.scene.requestRender(); } URL.revokeObjectURL(url); };
      }
    }).catch(() => { /* run not finished or map unavailable */ });
    return () => { cancelled = true; remove(); };
  }, [viewer, runId, basemap, bkey]);  // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ---------------------------------------------------------------- loads on buildings
const chip: CSSProperties = {
  display: "block", padding: "2px 7px 3px", background: "color-mix(in srgb, var(--ground) 84%, transparent)", backdropFilter: "blur(6px)", color: "var(--hazard)",
  border: "1px solid transparent", borderColor: "color-mix(in srgb, var(--ink) 10%, transparent)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", whiteSpace: "nowrap",
  fontSize: 12, lineHeight: "16px", fontWeight: 600, fontFamily: "inherit", cursor: "pointer", pointerEvents: "auto", ...FIG,
};
export const fmtKNm = (v: number) => (v >= 10 ? `${Math.round(v)}` : `${+v.toFixed(1)}`);

function LoadChips({ scene, anchors, aoi, runId, buildingsUrl, onBuilding, viewer }: MapProps & { runId: string }) {
  const fh = useFlowHazard();
  // Load the json only while the layer is on (this component only exists then), turn it into rows, publish them for the dock.
  useEffect(() => {
    if (!aoi || !buildingsUrl) return;
    let off = false;
    flowStore.set({ loadsLoading: true, loads: null });
    Promise.all([getLoads(runId), getHazardLegend(runId), buildingIndex(buildingsUrl), placesOf(aoi.aoi_id)]).then(([j, legend, idx, places]) => {
      if (off) return;
      if (!j) { flowStore.set({ loads: null, loadsLoading: false }); return; }
      const rows: LoadRow[] = [];
      j.ids.forEach((id, i) => {
        const b = idx.get(id);
        if (!b) return;
        const kN = j.drag_kN[i] + j.hydrostatic_kN[i], width = Math.max(j.width_m[i], 1);
        const named = j.names?.[i] ?? j.addresses?.[i] ?? null;
        rows.push({ id, lon: b.lon, lat: b.lat, kN, kNm: kN / width, dominant: j.hydrostatic_kN[i] >= j.drag_kN[i] ? "hydrostatic" : "drag",
          cls: hazardClass(j.depth_m[i], j.speed_m_s[i], legend), place: named ?? places.find((pl: { name: string; ring: [number, number][] }) => inRing(b.lon, b.lat, pl.ring))?.name ?? null,
          t_s: j.t_s[i], depth: j.depth_m[i], speed: j.speed_m_s[i] });
      });
      rows.sort((a, b) => b.kNm - a.kNm);
      flowStore.set({ loads: rows, loadsLoading: false });
    }).catch(() => { if (!off) flowStore.set({ loads: null, loadsLoading: false }); });
    return () => { off = true; flowStore.set({ loads: null, loadsLoading: false }); };
  }, [runId, aoi?.aoi_id, buildingsUrl]);  // eslint-disable-line react-hooks/exhaustive-deps

  // A row of the dock's list was clicked: fly there and select the building.
  const req = fh.request;
  useEffect(() => {
    if (!req) return;
    setFocus({ lon: req.lon, lat: req.lat });
    onBuilding?.(req.id, false);
  }, [req?.n]);  // eslint-disable-line react-hooks/exhaustive-deps

  const chips = useMemo(() => {
    const rows = fh.loads ?? [];
    const over = rows.filter((r) => r.kNm >= CHIP_MIN_KNM).slice(0, CHIP_MAX);
    return over.length ? over : rows.slice(0, 10);
  }, [fh.loads]);
  void viewer;
  return (
    <>
      {chips.map((r) => (
        <Anchored key={r.id} anchors={anchors} scene={scene} lon={r.lon} lat={r.lat} dy={-6}>
          <button type="button" title={`${r.place ? `${r.place} · ` : ""}${r.id}: ${Math.round(r.kN)} kN in all`} data-declutter={2} onClick={() => requestBuilding(r)}
            style={{ ...chip, position: "absolute", left: 0, top: 0, transform: "translate(-50%, -100%)", ...(fh.selectedId === r.id ? { borderColor: "var(--danfo)" } : {}) }}>
            {fmtKNm(r.kNm)} kN/m</button>
        </Anchored>
      ))}
    </>
  );
}

// The dock's side panel: rows sorted by load.
export function LoadsPanel() {
  const fh = useFlowHazard();
  const rows = fh.loads;
  const empty = (t: string) => <p style={{ margin: 0, padding: "10px 14px", color: "var(--ink-muted)", fontSize: 12 }}>{t}</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid var(--hairline)", minHeight: 0, background: "var(--surface)" }}>
      <Band title="Loads on buildings" />
      <ol style={{ margin: 0, padding: 0, listStyle: "none", minHeight: 0, overflowY: "auto" }}>
        {rows?.slice(0, LIST_MAX).map((r) => {
          const on = fh.selectedId === r.id;
          return (
            <li key={r.id} title={`${r.id} · peak at ${fmtT(r.t_s)}, ${r.depth.toFixed(2)} m deep, ${r.speed.toFixed(2)} m/s`} onClick={() => requestBuilding(r)}
              style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", columnGap: 10, alignItems: "center", padding: "7px 12px 7px 14px", cursor: "pointer",
                ...(on ? { background: "var(--surface-raised)", boxShadow: "inset 3px 0 0 var(--danfo), inset 0 1px 0 var(--elev-hi), 0 1px 2px var(--elev-drop-soft)" } : {}) }}>
              <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.place ? <>{r.place}<span style={{ fontWeight: 400, color: "var(--ink-muted)" }}> · {r.id}</span></> : r.id}</span>
              <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{fmtKNm(r.kNm)} kN/m</span>
              <span style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--ink-muted)" }}>{r.dominant} · H{r.cls}</span>
            </li>
          );
        })}
        {rows && !rows.length && empty("No building carries a load in this run.")}
        {!rows && (fh.loadsLoading ? empty("Loading building loads") : empty("Loads are not available for this run."))}
      </ol>
      <p style={{ margin: "auto 14px 10px", paddingTop: 6, color: "var(--ink-muted)", fontSize: 11, lineHeight: "15px" }}>{LOADS_LABEL}</p>
    </div>
  );
}

// ---------------------------------------------------------------- the depth profile line on the map
const handleStyle = (): CSSProperties => ({
  position: "absolute", left: 0, top: 0, transform: "translate(-50%, -50%)", width: 22, height: 22, borderRadius: "50%", background: "var(--danfo)", color: "var(--on-danfo)",
  border: "2px solid var(--ground)", boxShadow: "var(--shadow-float)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700,
  pointerEvents: "auto", cursor: "grab", touchAction: "none", userSelect: "none",
});
const pill: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, height: 28, padding: "0 12px", background: "color-mix(in srgb, var(--ground) 84%, transparent)", backdropFilter: "blur(6px)",
  border: "1px solid color-mix(in srgb, var(--ink) 10%, transparent)", borderRadius: "var(--radius-pill)", boxShadow: "var(--shadow-float)", fontSize: 12, whiteSpace: "nowrap",
};

function ProfileMap({ viewer, scene, anchors, aoi, runId, tS, basemap }: MapProps & { runId?: string }) {
  const lay = useLayers();
  const fh = useFlowHazard();
  const on = lay.profile.on;
  const { a, b, drawing } = fh;
  const aoiId = aoi?.aoi_id;
  void tS;

  // Two-click mode: the first click sets A, the second sets B. Esc cancels.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !drawing) return;
    const canvas = viewer.canvas, s = viewer.scene;
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    let down: { x: number; y: number } | null = null;
    const local = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const onDown = (e: PointerEvent) => { down = e.button === 0 ? local(e) : null; };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return;
      const { x, y } = local(e);
      const moved = Math.hypot(x - down.x, y - down.y) > 4;
      down = null;
      if (moved) return;
      const hit = pickGround(viewer, x, y);
      if (!hit) return;
      const c = Cesium.Cartographic.fromCartesian(hit);
      const pt: LL = [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
      const st = flowStore.get();
      // Deferred so the map's own click handler (which pins a point) still sees the mode and stands down for this click.
      setTimeout(() => flowStore.set(st.drawing === "a" ? { a: pt, b: null, drawing: "b", profile: null } : { b: pt, drawing: null }), 0);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") flowStore.set({ drawing: null }); };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      canvas.style.cursor = prevCursor;
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [viewer, drawing]);

  // The line, danfo. Aerial: clamped to the ground. Photoreal: clamping onto the 3D tiles breaks it into dots, so it follows
  // the terrain just above the street and shows dimmer where buildings hide it.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !on || !a || !b) return;
    const danfo = cssColor("--danfo");
    let polyline: Cesium.PolylineGraphics.ConstructorOptions;
    if (basemap === "photoreal") {
      const N = 64, pts: Cesium.Cartesian3[] = [];
      for (let k = 0; k <= N; k++) {
        const lon = a[0] + ((b[0] - a[0]) * k) / N, lat = a[1] + ((b[1] - a[1]) * k) / N;
        const g = viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat)) ?? 0;
        pts.push(Cesium.Cartesian3.fromDegrees(lon, lat, g + PHOTOREAL_LIFT_M));
      }
      polyline = { positions: pts, width: 3, arcType: Cesium.ArcType.NONE, material: danfo, depthFailMaterial: danfo.withAlpha(0.5) };
    } else {
      polyline = { positions: Cesium.Cartesian3.fromDegreesArray([...a, ...b]), width: 3, clampToGround: true, material: danfo };
    }
    const e = viewer.entities.add({ polyline });
    return () => { if (!viewer.isDestroyed()) viewer.entities.remove(e); };
  }, [viewer, on, basemap, a?.[0], a?.[1], b?.[0], b?.[1]]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Sample the line (debounced while a handle is dragged).
  useEffect(() => {
    if (!on || !a || !b || !aoiId || !runId) { if (fh.profile) flowStore.set({ profile: null }); return; }
    let live = true;
    const timer = setTimeout(() => {
      sampleProfile(aoiId, runId, a, b, () => live, (prof) => { if (live) flowStore.set({ profile: prof }); }).catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [on, a?.[0], a?.[1], b?.[0], b?.[1], aoiId, runId]);  // eslint-disable-line react-hooks/exhaustive-deps

  const drag = (which: "a" | "b") => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!viewer || viewer.isDestroyed()) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.style.cursor = "grabbing";
    const canvas = viewer.canvas, s = viewer.scene;
    const move = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const hit = pickGround(viewer, ev.clientX - r.left, ev.clientY - r.top);
      if (!hit) return;
      const c = Cesium.Cartographic.fromCartesian(hit);
      flowStore.set({ [which]: [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)] as LL });
    };
    const up = () => { el.style.cursor = "grab"; el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  if (!on) return null;
  return (
    <>
      {drawing && (
        <span style={{ ...pill, position: "absolute", left: "50%", top: 62, transform: "translateX(-50%)", pointerEvents: "none" }}>
          {drawing === "a" ? "Click the map for point A" : "Click the map for point B"} · Esc to cancel
        </span>
      )}
      {a && <Anchored anchors={anchors} scene={scene} lon={a[0]} lat={a[1]}><div role="slider" aria-label="Profile start A, drag to move" aria-valuetext="A" tabIndex={0} style={handleStyle()} onPointerDown={drag("a")}>A</div></Anchored>}
      {b && <Anchored anchors={anchors} scene={scene} lon={b[0]} lat={b[1]}><div role="slider" aria-label="Profile end B, drag to move" aria-valuetext="B" tabIndex={0} style={handleStyle()} onPointerDown={drag("b")}>B</div></Anchored>}
    </>
  );
}

// ============================================================ the dock's chart area while the profile is on
const fmtLen = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const tick = (v: number) => String(+v.toFixed(1));

export function ProfileDock() {
  const fh = useFlowHazard();
  const { t_s } = useClock();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const prof = fh.profile;
  const frame = prof?.t_s.length ? nearestFrame(prof.t_s, t_s) : 0;
  const pts = useMemo(() => (prof ? profileAt(prof, frame) : []), [prof, frame]);
  const right = `A to B at ${fmtT(t_s)} · reconstructed from the depth-averaged flow; not a 3D result`;
  const deepest = pts.reduce((m, q) => Math.max(m, q.depth), 0);
  const have = pts.length > 1;
  const W = size.w, H = size.h, L = 40, Rm = 12, T = 8, B = 20;
  let svg: React.ReactNode = null;
  if (have && W > 80 && H > 50 && prof) {
    const lo = Math.floor(Math.min(...pts.map((q) => q.ground)) - 0.3), hiRaw = Math.max(...pts.map((q) => q.water), lo + 1);
    const hi = Math.ceil(hiRaw + 0.2), span = hi - lo;
    const pw = W - L - Rm, ph = H - T - B, base = T + ph;
    const X = (x: number) => L + (pw * x) / Math.max(1, prof.lenM), Y = (v: number) => T + ph * (1 - (v - lo) / span);
    const line = (f: (q: (typeof pts)[number]) => number) => pts.map((q, i) => `${i ? "L" : "M"}${X(q.x).toFixed(1)} ${Y(f(q)).toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1], first = pts[0];
    const groundArea = `${line((q) => q.ground)} L${X(last.x).toFixed(1)} ${base} L${X(first.x).toFixed(1)} ${base} Z`;
    const waterArea = `${line((q) => q.water)} ${[...pts].reverse().map((q) => `L${X(q.x).toFixed(1)} ${Y(q.ground).toFixed(1)}`).join(" ")} Z`;
    const yt = [lo, lo + span / 2, hi];
    svg = (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Water and ground along the line from A to B, ${fmtLen(prof.lenM)}; deepest ${deepest.toFixed(1)} metres`}
        style={{ display: "block", overflow: "visible", fontFamily: "var(--font-sans)", fontSize: "var(--chart-tick, 10.5px)", ...FIG }}>
        {yt.map((v, k) => (
          <g key={k}>
            {k > 0 && <line x1={L} y1={Y(v)} x2={W - Rm} y2={Y(v)} stroke="var(--hairline)" strokeWidth="1" />}
            <text x={L - 6} y={Y(v) + 3.5} textAnchor="end" fill="var(--ink-muted)">{tick(v)} m</text>
          </g>
        ))}
        <path d={groundArea} fill="var(--ink-muted)" opacity="0.32" />
        <path d={waterArea} fill="var(--depth-3)" opacity="0.5" />
        <path d={line((q) => q.ground)} fill="none" stroke="var(--ink-muted)" strokeWidth="1.25" strokeLinejoin="round" />
        <path d={line((q) => q.water)} fill="none" stroke="var(--depth-3)" strokeWidth="1.75" strokeLinejoin="round" />
        <line x1={L} y1={base} x2={W - Rm} y2={base} stroke="var(--control-edge)" strokeWidth="1" />
        <text x={L} y={H - 5} textAnchor="start" fill="var(--danfo-text, var(--ink))" fontWeight="600">A</text>
        <text x={W - Rm} y={H - 5} textAnchor="end" fill="var(--danfo-text, var(--ink))" fontWeight="600">B · {fmtLen(prof.lenM)}</text>
        {prof.pending > 0 && <text x={W / 2} y={H - 5} textAnchor="middle" fill="var(--ink-muted)">sampling {prof.pending} more points</text>}
      </svg>
    );
  }
  const msg = !fh.a || !fh.b ? (fh.drawing ? (fh.drawing === "a" ? "Click the map for point A" : "Click the map for point B") : "Press Draw a line, then click point A and point B on the map")
    : prof && prof.pending === 0 && !have ? "No ground data along this line (outside the model area)" : "Sampling the line";
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, borderTop: "1px solid var(--hairline)" }}>
      <Band title="Depth along the line" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{have ? right : "reconstructed from the depth-averaged flow; not a 3D result"}</span>} />
      <figure style={{ margin: 0, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 4, padding: "8px 14px 6px" }}>
        <figcaption style={{ display: "flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap" }}>
          <span style={{ fontWeight: 600 }}>Water and ground</span><span style={{ color: "var(--ink-muted)" }}>(m)</span>
          {have && <span style={{ marginLeft: "auto", fontWeight: 600, ...FIG }}>deepest {deepest.toFixed(1)} m</span>}
        </figcaption>
        <div ref={box} style={{ flex: 1, minHeight: 60, position: "relative", minWidth: 0 }}>
          {svg ?? <p style={{ margin: 0, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 12 }}>{msg}</p>}
        </div>
      </figure>
    </div>
  );
}

export { metres };
