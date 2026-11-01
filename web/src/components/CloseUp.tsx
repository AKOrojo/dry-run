// 3D close-up: the map layer (outlines, chips, water mesh, flow arrows, force arrows, legend), the Inspect-tab cards
// and the dock. State lives in lib/patch3d.ts; the one clock picks the frame.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import * as Cesium from "cesium";
import { ArrowLeft, Cube, Info } from "@phosphor-icons/react";
import { Anchored } from "./Anchored";
import type { Anchors } from "./Anchored";
import { ProvenanceBadge, fmtT } from "./ds";
import { ChartFigure } from "./Dock";
import { Band, Card, FIG, Segmented, raisedButton } from "./rev5";
import { Switch as Toggle } from "./controls/Switch";
import { clock, useClock } from "../lib/clock";
import { layers, setLayer, useLayers } from "../lib/layers";
import { compassOf } from "../lib/rain";
import {
  PatchData, WATER_LIFT_M, firstSettledIndex, frameIndex, loadPatch, closeup, setCloseUp, setShow, useCloseUp, volumeCaveat,
} from "../lib/patch3d";
import { Tooltip } from "./controls/Tooltip";
import { Button } from "./controls/Button";

const cssColor = (name: string) => Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PITCH = Cesium.Math.toRadians(-35);
const HEADING = Cesium.Math.toRadians(20);
const FRAME_MS = 500;  // about 2 frames a second
const ARROW_S = 6;     // an arrow is the distance the water travels in this many seconds
const ARROW_MAX_M = 12;
const FORCE_NEAR_S = 30;

/** Ground heights at lon/lat points: the terrain mesh, most detailed (0 on the ellipsoid or on failure). */
async function sampleGround(v: Cesium.Viewer, pts: [number, number][]): Promise<number[]> {
  const t0 = performance.now();
  while (!v.isDestroyed() && v.terrainProvider instanceof Cesium.EllipsoidTerrainProvider && performance.now() - t0 < 4000) await sleep(200);
  if (v.isDestroyed() || v.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) return pts.map(() => 0);
  const cartos = pts.map(([lo, la]) => Cesium.Cartographic.fromDegrees(lo, la));
  try { await Cesium.sampleTerrainMostDetailed(v.terrainProvider, cartos); }
  catch { try { await Cesium.sampleTerrain(v.terrainProvider, 12, cartos); } catch { /* flat */ } }
  return cartos.map((c) => (Number.isFinite(c.height) ? c.height : 0));
}

const mPerDegLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
const legendMax = (d: PatchData) => Math.max(0.5, Math.ceil(d.maxDepth * 10) / 10);
const emphasised = (b: { t_s: number }, tS: number) => Math.abs(b.t_s - tS) <= FORCE_NEAR_S;

type Scn = {
  ground: Float64Array; cellGround: Float64Array; bGround: number[];
  water: Cesium.Primitive[]; arrows: Cesium.PolylineCollection; forces: Cesium.PolylineCollection; fPolys: Cesium.Polyline[];
  hz: Cesium.Color; ink: Cesium.Color; tips: [number, number][];
};

/** The water surface of one frame: (nx+1) x (ny+1) vertices at ground + depth, a texture whose alpha rises with depth. */
function waterPrimitive(d: PatchData, fi: number, ground: Float64Array, rgb: Cesium.Color, lmax: number): Cesium.Primitive {
  const { nx, ny } = d.manifest, [w, s, e, n] = d.manifest.bounds_wgs84, depth = d.frames[fi].depth;
  const vx = nx + 1, vy = ny + 1;
  const pos = new Float64Array(vx * vy * 3), nrm = new Float32Array(vx * vy * 3), st = new Float32Array(vx * vy * 2);
  const c3 = new Cesium.Cartesian3(), up = new Cesium.Cartesian3();
  for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
    let sum = 0, cnt = 0;
    for (const [ci, cj] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]]) {
      if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) continue;
      const dd = depth[cj * nx + ci];
      if (dd > 0) { sum += dd; cnt++; }
    }
    const k = j * vx + i;
    Cesium.Cartesian3.fromDegrees(w + (i / nx) * (e - w), n - (j / ny) * (n - s), ground[k] + WATER_LIFT_M + (cnt ? sum / cnt : 0), undefined, c3);
    pos[k * 3] = c3.x; pos[k * 3 + 1] = c3.y; pos[k * 3 + 2] = c3.z;
    Cesium.Cartesian3.normalize(c3, up);
    nrm[k * 3] = up.x; nrm[k * 3 + 1] = up.y; nrm[k * 3 + 2] = up.z;
    st[k * 2] = i / nx; st[k * 2 + 1] = 1 - j / ny;
  }
  const idx = new Uint16Array(nx * ny * 6);
  let o = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * vx + i, b = a + 1, c = a + vx, dd = c + 1;
    idx.set([a, c, b, b, c, dd], o); o += 6;
  }
  const attributes = new Cesium.GeometryAttributes();
  attributes.position = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos });
  attributes.normal = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: nrm });
  attributes.st = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st });
  const geometry = new Cesium.Geometry({
    attributes,
    indices: idx, primitiveType: Cesium.PrimitiveType.TRIANGLES, boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(pos)),
  });
  const cv = document.createElement("canvas");
  cv.width = nx; cv.height = ny;
  const g = cv.getContext("2d")!, img = g.createImageData(nx, ny);
  for (let i = 0; i < nx * ny; i++) {
    img.data[i * 4] = Math.round(rgb.red * 255); img.data[i * 4 + 1] = Math.round(rgb.green * 255); img.data[i * 4 + 2] = Math.round(rgb.blue * 255);
    img.data[i * 4 + 3] = depth[i] > 0 ? Math.round(255 * (0.3 + 0.62 * Math.min(1, depth[i] / lmax))) : 0;
  }
  g.putImageData(img, 0, 0);
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }), asynchronous: false, allowPicking: false, compressVertices: false, shadows: Cesium.ShadowMode.DISABLED,
    appearance: new Cesium.MaterialAppearance({ material: Cesium.Material.fromType("Image", { image: cv, color: new Cesium.Color(1, 1, 1, 1) }), flat: true, translucent: true, faceForward: false }),
  });
}

// A polyline owns (and destroys) its material, so every arrow gets its own.
/** Off screen, the chip waits at the map edge, clear of the compass, the top controls and the bottom-right buttons. */
const CHIP_CLAMP: [number, number, number, number] = [16, 150, 220, 90];
const arrowMat = (c: Cesium.Color) => Cesium.Material.fromType("PolylineArrow", { color: c });

export function CloseUpMap({ viewer, scene, anchors, runId, runsBase, buildingsUrl }: {
  viewer?: Cesium.Viewer; scene?: Cesium.Scene; anchors: React.MutableRefObject<Anchors>; runId?: string; runsBase: string; buildingsUrl?: string;
}) {
  const cu = useCloseUp();
  const lay = useLayers();
  const { t_s } = useClock();
  const { active, data, patches, show, channel } = cu;
  const scn = useRef<Scn | null>(null);
  const [ready, setReady] = useState(0);
  const saved = useRef<{ pos: Cesium.Cartesian3; dir: Cesium.Cartesian3; up: Cesium.Cartesian3; t_s: number; playing: boolean; water: boolean } | null>(null);
  const local = cu.local;
  const row = local ? local.data.row : patches.find((p) => p.patch_id === active);
  const fi = data ? frameIndex(data.manifest, t_s) : 0;

  // ----- dashed outlines on the map (always for the open one) -----
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const ink = cssColor("--ink");
    const made = (local ? [local.data.row] : patches.filter((p) => lay.closeups.on || p.patch_id === active)).map((p) => {
      const [w, s, e, n] = p.bounds_wgs84;
      return viewer.entities.add({ polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n, w, s]), width: 2, clampToGround: true,
        classificationType: Cesium.ClassificationType.BOTH, material: new Cesium.PolylineDashMaterialProperty({ color: ink, dashLength: 12 }),
      } });
    });
    return () => { if (!viewer.isDestroyed()) made.forEach((m) => viewer.entities.remove(m)); };
  }, [viewer, patches, lay.closeups.on, active, local]);

  // ----- entering and leaving: camera, clock, 2D water, credit, data -----
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !active || !row) return;
    let off = false;
    const cam = viewer.camera, now = clock.get();
    saved.current = { pos: cam.position.clone(), dir: cam.direction.clone(), up: cam.up.clone(), t_s: now.t_s, playing: now.playing, water: layers.get().water.on };
    clock.set({ playing: false });
    const [w, s, e, n] = row.bounds_wgs84, cx = (w + e) / 2, cy = (s + n) / 2;
    const h0 = viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(cx, cy)) ?? 0;
    cam.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(cx, cy, h0), 70), { duration: 1.8, offset: new Cesium.HeadingPitchRange(HEADING, PITCH, 230) });
    const credit = new Cesium.Credit(local ? "Dry Run WebGPU" : "OpenFOAM");
    viewer.creditDisplay.addStaticCredit(credit);
    setCloseUp({ status: "loading", data: null, playing: false });
    (local ? Promise.resolve(local.data) : loadPatch(runsBase, runId ?? "", row, buildingsUrl)).then((d) => {
      if (off) return;
      setCloseUp({ data: d, status: "ready" });
      clock.set({ t_s: d.manifest.frames[firstSettledIndex(d.manifest, d.spinup_s)].t_s, playing: false });
    }, () => { if (!off) setCloseUp({ status: "error" }); });
    return () => {
      off = true;
      const sv = saved.current;
      saved.current = null;
      if (!viewer.isDestroyed()) {
        viewer.creditDisplay.removeStaticCredit(credit);
        if (sv) viewer.camera.flyTo({ destination: sv.pos, orientation: { direction: sv.dir, up: sv.up }, duration: 1.5 });
      }
      if (sv) { setLayer("water", { on: sv.water }); clock.set({ t_s: sv.t_s, playing: sv.playing }); }
      setCloseUp({ status: "idle", data: null, playing: false, fly: null });
      if (local) { local.release(); if (closeup.get().local === local) setCloseUp({ local: null }); }  // a browser solve frees its frame blobs
    };
  }, [viewer, active, row?.patch_id, local]);
  useEffect(() => { if (active) setLayer("water", { on: show.twoD }); }, [active, show.twoD]);
  useEffect(() => {  // Esc leaves the close-up
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setCloseUp({ active: null }); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  // ----- play: step through the frames, the clock follows -----
  useEffect(() => {
    if (!cu.playing || !data) return;
    const id = window.setInterval(() => {
      const m = data.manifest, i = frameIndex(m, clock.get().t_s), last = m.frames.length - 1;
      clock.set({ t_s: m.frames[i >= last ? firstSettledIndex(m, data.spinup_s) : i + 1].t_s, playing: false });
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, [cu.playing, data]);

  // ----- the objects in the scene: one water mesh per frame, arrows, force arrows -----
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !data) return;
    let off = false;
    const { nx, ny } = data.manifest, [w, s, e, n] = data.manifest.bounds_wgs84;
    const pts: [number, number][] = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) pts.push([w + (i / nx) * (e - w), n - (j / ny) * (n - s)]);
    sampleGround(viewer, [...pts, ...data.buildings.map((b) => [b.lon, b.lat] as [number, number])]).then((g) => {
      if (off || viewer.isDestroyed()) return;
      const vx = nx + 1, nv = pts.length;
      const ground = Float64Array.from(g.slice(0, nv)), bGround = g.slice(nv);
      const cellGround = new Float64Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) cellGround[j * nx + i] = (ground[j * vx + i] + ground[j * vx + i + 1] + ground[(j + 1) * vx + i] + ground[(j + 1) * vx + i + 1]) / 4;
      const rgb = cssColor("--depth-3"), lmax = legendMax(data);
      const water = data.frames.map((_, k) => { const p = waterPrimitive(data, k, ground, rgb, lmax); p.show = false; viewer.scene.primitives.add(p); return p; });
      const arrows = new Cesium.PolylineCollection(), forces = new Cesium.PolylineCollection();
      viewer.scene.primitives.add(arrows); viewer.scene.primitives.add(forces);
      const hz = cssColor("--hazard"), ink = cssColor("--ink");
      const tips: [number, number][] = [];
      const fPolys = data.buildings.map((b, k) => {
        const len = 4 + 0.9 * b.kN, a = (b.dir_deg * Math.PI) / 180;
        const tip: [number, number] = [b.lon + (len * Math.sin(a)) / mPerDegLon(b.lat), b.lat + (len * Math.cos(a)) / 110540];
        tips.push(tip);
        // Just above the roof: from inside the walls the arrow would be hidden by our own building boxes.
        const h = bGround[k] + b.height_m + 1.5;
        return forces.add({ positions: Cesium.Cartesian3.fromDegreesArrayHeights([b.lon, b.lat, h, tip[0], tip[1], h]), width: 10, material: arrowMat(hz.withAlpha(0.75)) });
      });
      scn.current = { ground, cellGround, bGround, water, arrows, forces, fPolys, hz, ink, tips };
      setReady((r) => r + 1);
    });
    return () => {
      off = true;
      const sc = scn.current;
      scn.current = null;
      if (sc && !viewer.isDestroyed()) { sc.water.forEach((p) => viewer.scene.primitives.remove(p)); viewer.scene.primitives.remove(sc.arrows); viewer.scene.primitives.remove(sc.forces); }
    };
  }, [viewer, data]);

  // ----- what the playhead shows -----
  useEffect(() => {
    const sc = scn.current;
    if (!sc || !data || !viewer || viewer.isDestroyed()) return;
    sc.water.forEach((p, k) => { p.show = show.water && k === fi; });
    const { nx, ny } = data.manifest, [w, s, e, n] = data.manifest.bounds_wgs84, fr = data.frames[fi];
    sc.arrows.removeAll();
    if (show.arrows) {
      const U = channel === "surface" ? fr.us : fr.um, V = channel === "surface" ? fr.vs : fr.vm;
      for (let j = 1; j < ny; j += 3) for (let i = 1; i < nx; i += 3) {
        const k = j * nx + i, d = fr.depth[k];
        if (!(d > 0.05)) continue;
        const sp = Math.hypot(U[k], V[k]);
        if (sp < 0.03) continue;
        const len = Math.min(ARROW_MAX_M, sp * ARROW_S);
        const lon = w + ((i + 0.5) / nx) * (e - w), lat = n - ((j + 0.5) / ny) * (n - s), h = sc.cellGround[k] + WATER_LIFT_M + d + 0.25;
        sc.arrows.add({ positions: Cesium.Cartesian3.fromDegreesArrayHeights([lon, lat, h, lon + (len * U[k]) / sp / mPerDegLon(lat), lat + (len * V[k]) / sp / 110540, h]),
          width: 5, material: arrowMat(sc.ink.withAlpha(sp < 0.15 ? 0.35 : sp < 0.5 ? 0.55 : sp < 1.2 ? 0.8 : 1)) });
      }
    }
    const ft = data.manifest.frames[fi].t_s;
    sc.fPolys.forEach((p, k) => {
      const em = emphasised(data.buildings[k], ft);
      p.show = show.forces; p.width = em ? 14 : 10; p.material.uniforms.color = sc.hz.withAlpha(em ? 1 : 0.7);
    });
    viewer.scene.requestRender();
  }, [fi, data, show.water, show.arrows, show.forces, channel, ready, viewer]);

  // ----- fly to a building the dock asked for -----
  useEffect(() => {
    if (!cu.fly || !viewer || viewer.isDestroyed()) return;
    const f = cu.fly, c = viewer.camera;
    const h = viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(f.lon, f.lat)) ?? 0;
    c.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(f.lon, f.lat, h + f.height_m / 2), 25),
      { duration: 1.2, offset: new Cesium.HeadingPitchRange(c.heading, PITCH, 80) });
    setCloseUp({ fly: null });
  }, [cu.fly, viewer]);

  const frameT = data ? data.manifest.frames[fi].t_s : t_s;
  const settling = !!data && frameT - data.manifest.frames[0].t_s < data.spinup_s;
  const lmax = data ? legendMax(data) : 1;
  const pill: CSSProperties = { display: "flex", flexDirection: "column", gap: 1, padding: "5px 9px", background: "var(--surface-raised)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", textAlign: "left", font: "inherit", color: "var(--ink)", whiteSpace: "nowrap" };
  const chips = local ? [local.data.row] : patches.filter((p) => (active ? p.patch_id === active : lay.closeups.on));
  return (
    <>
      {chips.map((p) => {
        const e = p.bounds_wgs84[2], n = p.bounds_wgs84[3];
        return (
          <Anchored key={p.patch_id} anchors={anchors} scene={scene} lon={e} lat={active ? n : (n + p.bounds_wgs84[1]) / 2} dx={10} dy={-14}
            clamp={active ? undefined : CHIP_CLAMP}>
            {active ? (
              <div style={pill} data-declutter-phone={3}><span style={{ fontWeight: 600 }}>{p.label ?? "3D close-up"}</span>
                <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>{p.size_m} m box · {p.cell_m} m cells</span></div>
            ) : (
              <Tooltip text="Open the 3D close-up"><Button variant="raised" type="button" data-tour="closeup" data-declutter-phone={2} onClick={() => setCloseUp({ active: p.patch_id, status: "loading", data: null })}
                style={{ ...pill, flexDirection: "row", alignItems: "center", gap: 6, pointerEvents: "auto", cursor: "pointer", ...raisedButton, borderRadius: "var(--radius-md)", height: 26, padding: "0 9px 0 7px", fontSize: 12, fontWeight: 600 }}>
                <Cube size={14} weight="bold" />3D close-up · {p.size_m} m box
              </Button></Tooltip>
            )}
          </Anchored>
        );
      })}
      {active && data && show.forces && data.buildings.map((b, k) => {
        // Under 0.5 kN reads as "0 kN": a big box has dozens of those, so only the arrow stays (the dock lists every building).
        if (Math.round(b.kN) < 1) return null;
        const tip = scn.current?.tips[k] ?? [b.lon, b.lat];
        const em = emphasised(b, frameT);
        return (
          <Anchored key={b.id} anchors={anchors} scene={scene} lon={tip[0]} lat={tip[1]} dx={4} dy={-22}>
            <span data-declutter={em ? 4 : 1} style={{ display: "block", padding: "1px 6px", background: "color-mix(in srgb, var(--ground) 84%, transparent)", color: "var(--hazard)", borderRadius: "var(--radius-sm)",
              border: em ? "1px solid var(--hazard)" : "1px solid transparent", fontSize: 11, lineHeight: "16px", fontWeight: 700, whiteSpace: "nowrap", ...FIG }}>{Math.round(b.kN)} kN</span>
          </Anchored>
        );
      })}
      {active && (
        <>
          <div style={{ position: "absolute", top: 30, left: 64, pointerEvents: "auto" }}>
            <ProvenanceBadge kind="simulated">{`3D close-up · ${fmtT(frameT)}${settling ? " · settling" : ""}`}</ProvenanceBadge>
          </div>
          <div className="ft-legend" style={{ position: "absolute", left: 16, bottom: 44, pointerEvents: "none", boxShadow: "var(--shadow-float)" }}>
            <span className="ft-stat-label">Water depth</span>
            <span style={{ width: 190, height: 10, borderRadius: "var(--radius-pill)", border: "var(--stroke-hairline) solid var(--hairline)",
              background: "linear-gradient(90deg, color-mix(in srgb, var(--depth-3) 30%, transparent), var(--depth-3))" }} />
            <span style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--ink-muted)", ...FIG }}>
              <span>0</span><span>{+(lmax / 2).toFixed(2)}</span><span>{+lmax.toFixed(2)} m</span></span>
            <span style={{ display: "flex", gap: 14, fontSize: 11, color: "var(--ink-muted)" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true"><path d="M1 4H20M16 1l4 3-4 3" fill="none" stroke="var(--ink)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>flow 1 m/s</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true"><path d="M1 4H20M16 1l4 3-4 3" fill="none" stroke="var(--hazard)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>force 10 kN</span>
            </span>
          </div>
        </>
      )}
    </>
  );
}

// ---- sidebar ----
const dlStyle: CSSProperties = { margin: 0, padding: "10px 14px 12px", display: "grid", gridTemplateColumns: "112px minmax(0, 1fr)", rowGap: 7, columnGap: 10, fontSize: 13, lineHeight: "18px" };
const back = () => setCloseUp({ active: null });

function BackButton() {
  return (
    <div style={{ padding: "10px 2px 4px", borderTop: "1px solid var(--hairline)", marginTop: 4 }}>
      <Button variant="raised" type="button" onClick={back} style={{ ...raisedButton, height: 32, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 8, borderRadius: "var(--radius-md)", font: "inherit", fontWeight: 500 }}>
        <ArrowLeft size={14} weight="bold" />Back to the area
      </Button>
    </div>
  );
}

export function CloseUpCards() {
  const { data, status, show, channel } = useCloseUp();
  if (!data) {
    return (
      <>
        <Card title="3D close-up" right={<span style={{ marginLeft: "auto", display: "flex", color: "var(--ink-muted)" }}><Cube size={16} weight="bold" /></span>}>
          <p style={{ margin: 0, padding: 14, color: "var(--ink-muted)", fontSize: 12, lineHeight: "17px" }}>
            {status === "error" ? "The 3D close-up could not be loaded. The area run is unchanged." : "Loading the 3D solve and its frames"}</p>
        </Card>
        <BackButton />
      </>
    );
  }
  const m = data.manifest, w = m.t_window_s, cav = volumeCaveat(m.checks.volume_diff_end_pct);
  const dl: [string, string][] = [
    ["Solver", m.solver.startsWith("Dry Run WebGPU") ? "Solved on your GPU" : m.solver.split(",")[0]],
    ["Driven by", "the 2D run at its edges"],
    ["Box", `${data.row.size_m} × ${data.row.size_m} m · ${data.row.cell_m} m cells`],
    ["Time", `${fmtT(w[0])} → ${fmtT(w[1])}`],
    ["Settling", `first ${+(data.spinup_s / 60).toFixed(1)} min`],
  ];
  const row = (label: string, key: keyof typeof show, extra?: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 32 }}>
      <Toggle on={show[key]} label={label} onChange={(v) => setShow({ [key]: v })} />{extra}
    </div>
  );
  return (
    <>
      <Card title="3D close-up" right={<span style={{ marginLeft: "auto", display: "flex", color: "var(--ink-muted)" }}><Cube size={16} weight="bold" /></span>}>
        <dl style={dlStyle}>
          {dl.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt style={{ color: "var(--ink-muted)" }}>{k}</dt><dd style={{ margin: 0, minWidth: 0 }}>{v}</dd></div>)}
        </dl>
        {cav && (
          <div style={{ display: "flex", gap: 10, margin: "0 14px 14px", padding: "10px 12px", background: "var(--ground)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--inset-shadow)" }}>
            <Info size={14} weight="bold" color="var(--ink-muted)" style={{ flex: "none", marginTop: 2 }} />
            <p style={{ margin: 0, fontSize: 12, lineHeight: "17px" }}>
              Holds about {cav.pct} % {cav.word} water than the 2D run in the same box. It resolves the ground at {data?.row.cell_m ?? 2} m, so water drains {cav.word === "less" ? "lower" : "differently"}.</p>
          </div>
        )}
      </Card>
      <Card title="Show">
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 14px 12px" }}>
          {row("Water depth", "water")}
          {row("Flow arrows", "arrows", (
            <span style={{ marginLeft: "auto", width: 156 }}>
              <Segmented<"surface" | "mid"> active={channel} onChange={(c) => setCloseUp({ channel: c })} options={[{ value: "surface", label: "Surface" }, { value: "mid", label: "Mid-depth" }]} />
            </span>
          ))}
          {row("Forces on buildings", "forces")}
          {row("2D water for comparison", "twoD")}
        </div>
      </Card>
      <BackButton />
    </>
  );
}

// ---- dock ----
const sq: CSSProperties = { width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, borderRadius: "var(--radius-md)" };
const svg12 = (c: React.ReactNode) => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">{c}</svg>;

export function CloseUpDock() {
  const cu = useCloseUp();
  const { t_s } = useClock();
  const { data, status, playing } = cu;
  const shell: CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 248px", background: "var(--surface)", borderTop: "1px solid var(--hairline)", minHeight: 0 };
  const m = data?.manifest;
  const n = m?.frames.length ?? 0;
  const fi = m ? frameIndex(m, t_s) : 0;
  const ft = m ? m.frames[fi].t_s : 0;
  const t0 = m?.frames[0].t_s ?? 0, tN = m?.frames[n - 1]?.t_s ?? 0;
  const step = n > 1 ? (tN - t0) / (n - 1) : 30;
  const rows = useMemo(() => (data ? data.buildings.map((b, k) => ({ b, k })).sort((a, c) => c.b.kN - a.b.kN) : []), [data]);
  const pressed = { background: "var(--pressed-bg)", color: "var(--ground)", border: "1px solid var(--ink)", boxShadow: "var(--pressed-shadow)" };
  if (!data || !m) {
    return (
      <div data-tour="timeline" style={shell}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <Band title="3D close-up" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>10 minutes around the 2D peak</span>} />
          <p style={{ margin: 0, padding: 18, color: "var(--ink-muted)" }}>{status === "error" ? "The 3D close-up could not be loaded." : "Loading the 3D solve and its frames"}</p>
        </div>
        <div style={{ borderLeft: "1px solid var(--hairline)" }}><Band title="Forces on buildings" /></div>
      </div>
    );
  }
  const idxAt = (t: number) => Math.round((t - t0) / step);
  const xTicks = [0, (n - 1) / 2, n - 1].map((i) => ({ i, label: fmtT(t0 + i * step) }));
  const span = { from: 0, to: Math.min(n - 1, data.spinup_s / step), label: "Settling" };
  const common = { playI: fi, tTotal: tN - t0, xTicks, span, times: m.frames.map((f) => f.t_s) };
  const v3 = m.checks.water_volume_3d_m3, v2 = m.checks.water_volume_2d_m3;
  const kfmt = (v: number) => `${+(v / 1000).toFixed(1)}k`;
  const settled = Math.max(0, Math.min(n - 1, idxAt(t0 + data.spinup_s)));
  return (
    <div data-tour="timeline" style={shell}>
      <div style={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", minWidth: 0 }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <Band title="3D close-up" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>10 minutes around the 2D peak</span>} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px 8px 14px" }}>
            <Button variant="raised" type="button" aria-label="Play" aria-pressed={playing} style={{ ...sq, ...(playing ? pressed : raisedButton) }}
              onClick={() => { if (fi >= n - 1) clock.set({ t_s: m.frames[settled].t_s, playing: false }); setCloseUp({ playing: true }); }}>
              {svg12(<path d="M3 1.8v8.4L10 6z" fill="currentColor" />)}</Button>
            <Button variant="raised" type="button" aria-label="Pause" aria-pressed={!playing} style={{ ...sq, ...(!playing ? pressed : raisedButton) }} onClick={() => setCloseUp({ playing: false })}>
              {svg12(<><rect x="2.5" y="2" width="2.5" height="8" rx=".5" fill="currentColor" /><rect x="7" y="2" width="2.5" height="8" rx=".5" fill="currentColor" /></>)}</Button>
            <span style={{ ...FIG }}>Frame {fi + 1} of {n} · every {Math.round(step)} s</span>
            <span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>Same clock as the area run, inside {fmtT(t0)} → {fmtT(tN)}</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--hairline)", minHeight: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <ChartFigure title="Water in the box" unit="m³" digits={0} now={v3?.[fi] != null ? Math.round(v3[fi]).toLocaleString("en-GB") : "–"} series={v3} ghost={v2 && v2.length === v3?.length ? v2 : undefined}
              color="var(--depth-3)" gid="cv" yFmt={kfmt} aria={`Water volume in the box over the ten minutes; ${v3?.[fi] != null ? Math.round(v3[fi]) : "no"} cubic metres at the playhead`} {...common} />
            <ChartFigure title="Deepest water" unit="m" digits={2} now={data.series.maxDepth[fi].toFixed(2)} series={data.series.maxDepth} color="var(--depth-3)" gid="cd" ymaxMin={0.5}
              aria={`Deepest water in the box; ${data.series.maxDepth[fi].toFixed(2)} metres at the playhead`} {...common} />
            <ChartFigure last title="Fastest flow" unit="m/s" digits={1} now={data.series.maxSpeed[fi].toFixed(1)} series={data.series.maxSpeed} color="var(--ink)" gid="cf" ymaxMin={1}
              aria={`Fastest surface flow in the box; ${data.series.maxSpeed[fi].toFixed(1)} metres per second at the playhead`} {...common} />
          </div>
          <div style={{ padding: "0 14px 8px", color: "var(--ink-muted)", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="20" height="6" viewBox="0 0 20 6" aria-hidden="true"><line x1="0" y1="3" x2="20" y2="3" stroke="var(--ink-muted)" strokeWidth="1.5" strokeDasharray="3 3" /></svg>2D run in the same box
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid var(--hairline)", minHeight: 0, background: "var(--surface)" }}>
        <Band title="Forces on buildings" />
        <ol style={{ margin: 0, padding: 0, listStyle: "none", minHeight: 0, overflowY: "auto" }}>
          {rows.map(({ b }, r) => {
            const on = emphasised(b, ft);
            return (
              <li key={b.id} onClick={() => setCloseUp({ fly: { lon: b.lon, lat: b.lat, height_m: b.height_m } })}
                style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", columnGap: 10, alignItems: "center", padding: "7px 12px 7px 14px", cursor: "pointer",
                  ...(on ? { background: "var(--surface-raised)", boxShadow: "inset 3px 0 0 var(--danfo), inset 0 1px 0 var(--elev-hi), 0 1px 2px var(--elev-drop-soft)" } : {}) }}>
                <span style={{ fontWeight: 600 }}>Building {r + 1}</span>
                <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{Math.round(b.kN)} kN</span>
                <span style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--ink-muted)" }}>peak {fmtT(b.t_s)} · toward {compassOf(b.dir_deg)}</span>
              </li>
            );
          })}
        </ol>
        <p style={{ margin: "auto 14px 10px", paddingTop: 6, color: "var(--ink-muted)", fontSize: 11, lineHeight: "15px" }}>
          Net horizontal water pressure on the walls, after settling. No shear. Screening values, not design loads.</p>
      </div>
    </div>
  );
}
