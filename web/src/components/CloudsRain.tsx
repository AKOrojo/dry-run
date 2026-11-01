// Clouds and rain over the storm while Simulate runs, and during playback when "Clouds and rain" is on.
// The deck sits where the rain falls (storm cell, drawn area / place, or the whole AOI), darkens and rains harder
// with the hyetograph, follows a moving cell along its track, and thins out and drifts off after the rain stops.
// Cloud puffs are soft billboards (sized in metres) about 1.5 km up; rain is a few thousand falling streak billboards
// moved in a local east-north-up frame, so a frame costs one pass over the visible streaks. Colours come from the tokens.
import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import { Anchored } from "./Anchored";
import type { Anchors } from "./Anchored";
import { fmtT } from "./ds";
import { FIG } from "./rev5";
import { LonLat, metresBetween, offsetLL, rain as rainStore } from "../lib/rain";
import { clock } from "../lib/clock";
import { holdRendering } from "../lib/render";
import { sim } from "../lib/simstate";
import { liveModelT, weatherAt, weatherLabel, weatherSpec, useWeatherNow } from "../lib/weather";
import type { WeatherSource, WeatherSpec } from "../lib/weather";
import type { RunManifest } from "../lib/api";

const RAIN_MAX = 2200;
const PUFFS = 80;
const CLOUD_Z = [1450, 1900]; // metres above the ground
const RAIN_TOP = 1350;       // cloud base: where the streaks start
const FALL_PER_S = 0.9;      // fraction of the fall a streak covers each real second
const SLANT = 0.14;          // horizontal metres per vertical metre, toward the travel direction

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r() * 0.9999)) * Math.cos(2 * Math.PI * r());

/** A soft cloud lump: overlapping radial gradients, white, transparent at the edge. */
function cloudCanvas(seed: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!, r = rng(seed);
  for (let i = 0; i < 9; i++) {
    const a = r() * Math.PI * 2, d = r() * 26, x = 64 + Math.cos(a) * d, y = 64 + Math.sin(a) * d * 0.8, rad = 26 + r() * 22;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, "rgba(255,255,255,0.62)"); gr.addColorStop(0.55, "rgba(255,255,255,0.28)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  }
  g.globalCompositeOperation = "destination-in";
  const m = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  m.addColorStop(0, "rgba(0,0,0,1)"); m.addColorStop(0.7, "rgba(0,0,0,0.85)"); m.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = m; g.fillRect(0, 0, 128, 128);
  return c;
}
function streakCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 4; c.height = 48;
  const g = c.getContext("2d")!, gr = g.createLinearGradient(0, 0, 0, 48);
  gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(0.35, "rgba(255,255,255,0.7)"); gr.addColorStop(1, "rgba(255,255,255,0.95)");
  g.fillStyle = gr; g.fillRect(1, 0, 2, 48);
  return c;
}

const cssColor = (name: string) => Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888");
const lum = (c: Cesium.Color) => 0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue;

const inRing = (x: number, y: number, ring: LonLat[]) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** A point (metres east, north of the deck centre) drawn from the deck's footprint, thinner toward the edge for gaussian / exponential. */
function sampler(spec: WeatherSpec, r: () => number): () => { x: number; y: number; w: number } {
  const R = spec.radiusM;
  if (spec.kind === "cell") {
    return () => {
      const a = r() * Math.PI * 2;
      let d: number;
      if (spec.profile === "gaussian") d = Math.min(R * 1.05, Math.abs(gauss(r)) * R * 0.5);
      else if (spec.profile === "exponential") d = Math.min(R * 1.1, -Math.log(1 - r() * 0.98) * R * 0.32);
      else d = Math.sqrt(r()) * R;
      return { x: Math.cos(a) * d, y: Math.sin(a) * d, w: spec.profile === "flat" ? 1 : Math.max(0.15, 1 - (d / R) * 0.8) };
    };
  }
  const ring = spec.ring!, xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return () => {
    for (let k = 0; k < 60; k++) {
      const p: LonLat = [x0 + (x1 - x0) * r(), y0 + (y1 - y0) * r()];
      if (spec.kind === "whole" || inRing(p[0], p[1], ring)) { const m = metresBetween(spec.centre, p); return { x: m.east, y: m.north, w: 1 }; }
    }
    return { x: 0, y: 0, w: 1 };
  };
}

type Puff = { b: Cesium.Billboard; x: number; y: number; z: number; w: number; ph: number; size: number };
type Drop = { b: Cesium.Billboard; x: number; y: number; x0: number; y0: number; f0: number; speed: number; cyc: number; near: boolean };

/** The primitives and the per-frame update for one storm and rain area. */
function buildDeck(scene: Cesium.Scene, src: NonNullable<WeatherSource>, spec: WeatherSpec) {
  const r = rng(7);
  const clouds = new Cesium.BillboardCollection({ scene });
  const rainBb = new Cesium.BillboardCollection({ scene });
  scene.primitives.add(clouds);
  scene.primitives.add(rainBb);
  const covers = [cloudCanvas(1), cloudCanvas(2), cloudCanvas(3)];
  const sizeBase = spec.kind === "cell" ? Math.min(3200, Math.max(500, spec.radiusM * 0.55)) : Math.min(2600, Math.max(700, spec.radiusM * 0.35));
  const sample = sampler(spec, r);
  const near = new Cesium.NearFarScalar(500, 0, 4500, 1);
  const puffs: Puff[] = [];
  for (let i = 0; i < PUFFS; i++) {
    const s = sample();
    const size = sizeBase * (0.7 + r() * 0.7);
    const b = clouds.add({ position: Cesium.Cartesian3.ZERO, width: size, height: size * 0.72, sizeInMeters: true, translucencyByDistance: near,
      color: Cesium.Color.WHITE.withAlpha(0), rotation: r() * 6.28 });
    b.setImage(`dr-cloud-${i % 3}`, covers[i % 3]);
    puffs.push({ b, x: s.x, y: s.y, z: CLOUD_Z[0] + r() * (CLOUD_Z[1] - CLOUD_Z[0]), w: s.w, ph: r() * 6.28, size });
  }
  const heading = ((spec.track?.heading_deg ?? 90) * Math.PI) / 180;
  const sx = Math.sin(heading) * SLANT, sy = Math.cos(heading) * SLANT;
  const enu0 = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(spec.centre[0], spec.centre[1], 0));
  const axis = new Cesium.Cartesian3();
  const col = (c: number) => Cesium.Matrix4.getColumn(enu0, c, new Cesium.Cartesian4());
  const E0 = col(0), N0 = col(1), U0 = col(2);
  axis.x = -sx * E0.x - sy * N0.x + U0.x; axis.y = -sx * E0.y - sy * N0.y + U0.y; axis.z = -sx * E0.z - sy * N0.z + U0.z;
  Cesium.Cartesian3.normalize(axis, axis);
  const fall = new Cesium.NearFarScalar(300, 1.5, 12000, 0.95);
  const drops: Drop[] = [];
  const streak = streakCanvas();
  for (let i = 0; i < RAIN_MAX; i++) {
    const s = sample();
    const b = rainBb.add({ position: Cesium.Cartesian3.ZERO, width: 2.4, height: 26 + r() * 18, alignedAxis: axis, scaleByDistance: fall, show: false,
      color: Cesium.Color.WHITE.withAlpha(0.5), verticalOrigin: Cesium.VerticalOrigin.CENTER });
    b.setImage("dr-streak", streak);
    drops.push({ b, x: s.x, y: s.y, x0: s.x, y0: s.y, f0: r(), speed: 0.75 + r() * 0.5, cyc: -1, near: i % 4 !== 0 });
  }

  const origin = new Cesium.Cartesian3(), pos = new Cesium.Cartesian3(), ink = new Cesium.Color(), ground = new Cesium.Color(), tint = new Cesium.Color(), rainTint = new Cesium.Color();
  const still = reducedMotion();
  let groundH = 0, lastSample = 0, lastTheme = 0, inkLight = true, active = 0;
  const t0 = performance.now();
  // Zoomed in, most streaks are re-spawned around the point under the camera (inside the deck), so the rain is dense where you look.
  let focus: LonLat | null = null, nearR = 0, nearTop = RAIN_TOP, lastFocus = 0;
  const covered = (x: number, y: number) => (spec.kind === "cell" ? Math.hypot(x, y) <= spec.radiusM : inRing(...offsetLL(spec.centre, x, y), spec.ring!));
  const drift = ((spec.track?.heading_deg ?? 90) * Math.PI) / 180;

  const update = () => {
    const nowMs = performance.now(), time = still ? 0 : (nowMs - t0) / 1000;
    const t_s = src.live ? liveModelT(sim.get()) : clock.get().t_s;
    const rs = rainStore.get();
    const w = weatherAt(src.storm, spec, t_s, rs.preview, rs.bounds);
    const c = offsetLL(w.centre, w.drift * Math.sin(drift), w.drift * Math.cos(drift));
    if (nowMs - lastSample > 800 && scene.globe) {
      lastSample = nowMs;
      groundH = scene.globe.getHeight(Cesium.Cartographic.fromDegrees(c[0], c[1])) ?? groundH;
    }
    if (nowMs - lastTheme > 1000) {
      lastTheme = nowMs;
      Cesium.Color.clone(cssColor("--ink"), ink); Cesium.Color.clone(cssColor("--ground"), ground);
      inkLight = lum(ink) > 0.5;
    }
    // Thicker and darker with the rate: the ink share of the ink / ground mix moves with the storm's strength.
    const s = w.strength, share = inkLight ? 0.82 - 0.34 * s : 0.42 + 0.34 * s;
    Cesium.Color.lerp(ground, ink, share, tint);
    Cesium.Cartesian3.fromDegrees(c[0], c[1], groundH, Cesium.Ellipsoid.WGS84, origin);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin, Cesium.Ellipsoid.WGS84, scratchEnu);
    const ex = enu[0], ey = enu[1], ez = enu[2], nx = enu[4], ny = enu[5], nz = enu[6], ux = enu[8], uy = enu[9], uz = enu[10];
    const place = (x: number, y: number, z: number) => {
      pos.x = origin.x + ex * x + nx * y + ux * z; pos.y = origin.y + ey * x + ny * y + uy * z; pos.z = origin.z + ez * x + nz * y + uz * z;
      return pos;
    };
    if (nowMs - lastFocus > 400 && !scene.isDestroyed()) {
      lastFocus = nowMs;
      const camH = scene.camera.positionCartographic.height - groundH;
      if (camH < 3500) {
        const v = scene.canvas, hit = scene.globe.pick(scene.camera.getPickRay(new Cesium.Cartesian2(v.clientWidth / 2, v.clientHeight / 2)) as Cesium.Ray, scene);
        const cg = Cesium.Cartographic.fromCartesian(hit ?? scene.camera.positionWC);
        focus = [Cesium.Math.toDegrees(cg.longitude), Cesium.Math.toDegrees(cg.latitude)];
        nearR = Math.min(1800, Math.max(200, camH * 1.4));
        nearTop = Math.min(RAIN_TOP, Math.max(450, camH * 1.6 + 250));
      } else focus = null;
    }
    const fm = focus ? metresBetween(c, focus) : null;
    const dens = w.presence * (0.2 + 0.8 * s);
    for (const p of puffs) {
      const sway = Math.sin(time * 0.06 + p.ph) * p.size * 0.12;
      p.b.position = place(p.x + sway, p.y + Math.cos(time * 0.05 + p.ph) * p.size * 0.1, p.z);
      // Edge puffs of a gaussian / exponential cell are thinner, and the deck shrinks as it thins out.
      const a = Math.min(0.92, dens * (0.35 + 0.65 * p.w) * 1.05);
      p.b.color = Cesium.Color.fromAlpha(tint, a, scratchCol);
    }
    // Rain: the number of streaks follows the rate, and none once the storm is over.
    const want = Math.round(RAIN_MAX * Math.pow(s, 0.85) * (src.storm && t_s / 3600 <= src.storm.duration_h ? 1 : 0));
    const lo = Math.min(active, want), hi = Math.max(active, want);
    for (let i = lo; i < hi; i++) { drops[i].b.show = want > active; }
    active = want;
    Cesium.Color.lerp(ground, ink, inkLight ? 0.92 : 0.1, rainTint);
    const rainCol = Cesium.Color.fromAlpha(rainTint, 0.55 + 0.35 * s, scratchCol2);
    for (let i = 0; i < active; i++) {
      const d = drops[i];
      const cf = d.f0 + time * FALL_PER_S * d.speed, cyc = Math.floor(cf), f = cf - cyc;
      if (cyc !== d.cyc) {
        d.cyc = cyc;
        d.x = d.x0; d.y = d.y0;
        if (fm && d.near) {
          for (let k = 0; k < 5; k++) {
            const a = r() * 6.2832, rr = Math.sqrt(r()) * nearR, x = fm.east + Math.cos(a) * rr, y = fm.north + Math.sin(a) * rr;
            if (covered(x, y)) { d.x = x; d.y = y; break; }
          }
        }
      }
      const top = fm && d.near ? nearTop : RAIN_TOP;
      d.b.position = place(d.x + sx * top * f, d.y + sy * top * f, top * (1 - f));
      d.b.color = rainCol;
    }
  };
  const remove = () => {
    if (!scene.isDestroyed()) { scene.primitives.remove(clouds); scene.primitives.remove(rainBb); }
  };
  return { update, remove };
}
const scratchEnu = new Cesium.Matrix4();
const scratchCol = new Cesium.Color(), scratchCol2 = new Cesium.Color();

export function CloudsRain({ scene, anchors, src, hidden }: {
  viewer?: Cesium.Viewer; scene?: Cesium.Scene; anchors: React.MutableRefObject<Anchors>; run?: RunManifest; src: WeatherSource; hidden?: boolean;
}) {
  const wx = useWeatherNow(hidden ? null : src);
  const specKey = wx ? JSON.stringify([src?.storm, wx.spec]) : "";
  const live = useRef(src);
  live.current = src;
  useEffect(() => {
    if (!scene || scene.isDestroyed() || !specKey || !live.current) return;
    const spec = weatherSpec(live.current.storm, rainStore.get().places, rainStore.get().bounds);
    if (!spec) return;
    const deck = buildDeck(scene, live.current, spec);
    const off = scene.preRender.addEventListener(deck.update);
    deck.update();
    // The clouds drift and the rain falls every frame (the map otherwise renders on demand); held still with reduced motion.
    const release = reducedMotion() ? () => {} : holdRendering();
    return () => { release(); off(); deck.remove(); };
  }, [scene, specKey, src?.live]);
  if (!wx || !scene) return null;
  const { title, sub } = weatherLabel(wx.spec, wx.now, fmtT);
  if (wx.now.presence <= 0) return null;
  return (
    <Anchored anchors={anchors} scene={scene} lon={wx.now.centre[0]} lat={wx.now.centre[1]} clamp={[110, 80, 110, 130]}>
      <span data-testid="weather-label" className="dr-rain-chip" data-declutter-phone={2} style={{ position: "absolute", left: 0, top: 0, transform: "translate(-50%, calc(-100% - 18px))", background: "color-mix(in srgb, var(--ground) 86%, transparent)",
        backdropFilter: "blur(6px)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", padding: "4px 9px 5px",
        display: "flex", flexDirection: "column", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, ...FIG }}>{title}</span>
        {sub && <span style={{ fontSize: 11, color: "var(--ink-muted)", ...FIG }}>{sub}</span>}
      </span>
    </Anchored>
  );
}
