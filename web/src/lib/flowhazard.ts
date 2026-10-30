// Flow and hazard (design board 9): data fetching and the small store shared by the map, the sidebar card and the dock.
//  - velocity: per-frame u/v/speed PNGs (exact decode, cached per frame) and their manifest
//  - hazard: AIDR H1-H6 legend json and the class of a depth/speed pair
//  - building loads: per-building peak load json, only fetched while the layer is on
//  - depth profile: ground (from /api/aoi/point) and water depth per frame (from /series) along an A to B line
import { useSyncExternalStore } from "react";
import { API, getPointInfo, getPointSeries } from "./api";
import { decodePng } from "./patch3d";

export type LL = [number, number];

// ---- velocity ----
export type VelocityManifest = {
  nx: number; ny: number; block_m: number; bounds_wgs84: [number, number, number, number]; vmax_m_s: number; scale_m_s: number; peak_speed_m_s: number;
  wet_threshold_m: number; frames: { i: number; t_s: number }[]; method?: string;
};
const jsonCache = new Map<string, Promise<unknown>>();
function cachedJson<T>(url: string): Promise<T | null> {
  let p = jsonCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    jsonCache.set(url, p);
    p.then((v) => { if (v == null) jsonCache.delete(url); });
  }
  return p as Promise<T | null>;
}
export const getVelocityManifest = (runId: string) => cachedJson<VelocityManifest>(`${API}/api/runs/${runId}/derived/velocity.json`);
/** One decoded velocity frame: u east, v north (m/s), speed (m/s), wet mask. Row 0 is the north edge. */
export type VelocityFrame = { nx: number; ny: number; u: Float32Array; v: Float32Array; speed: Float32Array; wet: Uint8Array };
const frameCache = new Map<string, Promise<VelocityFrame>>();
export function getVelocityFrame(runId: string, i: number, m: VelocityManifest): Promise<VelocityFrame> {
  const key = `${runId}|${i}`;
  let p = frameCache.get(key);
  if (!p) {
    p = decodePng(`${API}/api/runs/${runId}/derived/velocity/${i}`).then((img) => {
      const n = img.w * img.h, u = new Float32Array(n), v = new Float32Array(n), speed = new Float32Array(n), wet = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        const a = img.rgba[k * 4 + 3];
        if (a < 128) continue;
        wet[k] = 1;
        u[k] = (img.rgba[k * 4] - 128) * m.scale_m_s;
        v[k] = (img.rgba[k * 4 + 1] - 128) * m.scale_m_s;
        speed[k] = (img.rgba[k * 4 + 2] / 255) * m.vmax_m_s;
      }
      return { nx: img.w, ny: img.h, u, v, speed, wet };
    });
    p.catch(() => frameCache.delete(key));
    frameCache.set(key, p);
    if (frameCache.size > 600) frameCache.delete(frameCache.keys().next().value as string);
  }
  return p;
}
/** Index of the frame nearest a time. */
export const nearestFrame = (ts: number[], t: number) => {
  let best = 0;
  for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i] - t) < Math.abs(ts[best] - t)) best = i;
  return best;
};

// ---- hazard ----
export type HazardClass = { class: string; description: string; alpha: number; limits: { dv_m2_s?: number; depth_m?: number; velocity_m_s?: number; dv_m2_s_above?: number } };
export type HazardLegend = { classes: HazardClass[]; rgb: string; source: string; note: string };
export const getHazardLegend = (runId: string) => cachedJson<HazardLegend>(`${API}/api/runs/${runId}/derived/hazard.json`);
export const HAZARD_CAPTION = "H1 safe for people · H6 unsafe for all buildings";
/** 1..6: the first AIDR row whose D*V, depth and velocity limits all hold (read from hazard.json), else H6. */
export function hazardClass(depth: number, speed: number, legend: HazardLegend | null): number {
  const rows = legend?.classes ?? [];
  for (let k = 0; k < rows.length - 1; k++) {
    const l = rows[k].limits;
    if (l.dv_m2_s != null && depth * speed <= l.dv_m2_s && depth <= (l.depth_m ?? Infinity) && speed <= (l.velocity_m_s ?? Infinity)) return k + 1;
  }
  return 6;
}

// ---- building loads ----
export type LoadsJson = {
  n_buildings: number; n_loaded: number; ids: string[]; t_s: number[]; depth_m: number[]; speed_m_s: number[]; width_m: number[];
  drag_kN: number[]; hydrostatic_kN: number[]; method: string;
  /** Not in the file today; used when a later revision adds them. */
  names?: (string | null)[]; addresses?: (string | null)[];
};
export const LOADS_LABEL = "Indicative screening values from 30 m model cells, not design loads.";
export const getLoads = (runId: string) => cachedJson<LoadsJson>(`${API}/api/runs/${runId}/derived/building_loads.json`);
export type LoadRow = {
  id: string; lon: number; lat: number; /** total kN per metre of wall */ kNm: number; kN: number;
  /** the larger of the two parts: hydrostatic applies only while water stands on one side, and the json already counts it that way */ dominant: "hydrostatic" | "drag";
  cls: number; place: string | null; t_s: number; depth: number; speed: number;
};

// ---- store ----
export type Profile = {
  key: string; /** metres along the line */ dist: number[]; ground: (number | null)[]; /** depth per sample per frame; null where /series had none */ depth: (Float32Array | number[] | null)[];
  t_s: number[]; lenM: number; pending: number;
};
type State = {
  a: LL | null; b: LL | null;
  /** two-click mode: which end the next click on the map sets */ drawing: "a" | "b" | null;
  loads: LoadRow[] | null; loadsLoading: boolean; selectedId: string | null;
  /** a row of the loads list was clicked: the map flies there and selects the building */ request: { id: string; lon: number; lat: number; n: number } | null;
  profile: Profile | null;
};
let state: State = { a: null, b: null, drawing: null, loads: null, loadsLoading: false, selectedId: null, request: null, profile: null };
const subs = new Set<() => void>();
export const flowStore = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  set(p: Partial<State>) { state = { ...state, ...p }; subs.forEach((f) => f()); },
};
export const useFlowHazard = () => useSyncExternalStore(flowStore.subscribe, flowStore.get);
let reqN = 0;
export const requestBuilding = (r: { id: string; lon: number; lat: number }) => flowStore.set({ selectedId: r.id, request: { ...r, n: ++reqN } });

// ---- the depth profile ----
export const PROFILE_POINTS = 40;
const R = 6371008.8;
export function metres(a: LL, b: LL): number {
  const k = Math.PI / 180, la = (a[1] + b[1]) / 2 * k;
  return Math.hypot((b[0] - a[0]) * k * R * Math.cos(la), (b[1] - a[1]) * k * R);
}
export const along = (a: LL, b: LL, f: number): LL => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
const groundCache = new Map<string, Promise<number | null>>();
function groundAt(aoiId: string, p: LL): Promise<number | null> {
  const key = `${aoiId}|${p[0].toFixed(5)}|${p[1].toFixed(5)}`;
  let g = groundCache.get(key);
  if (!g) {
    g = getPointInfo(aoiId, p[0], p[1]).then((i) => (i && Number.isFinite(i.ground_m) ? i.ground_m : null));
    groundCache.set(key, g);
    if (groundCache.size > 2000) groundCache.delete(groundCache.keys().next().value as string);
  }
  return g;
}
const BATCH = 6;
/** Sample the line; ground and depth fetched in small batches. `onPart` gets the profile as it fills; resolves when done. */
export async function sampleProfile(aoiId: string, runId: string, a: LL, b: LL, live: () => boolean, onPart: (p: Profile) => void): Promise<void> {
  const lenM = metres(a, b);
  const pts = Array.from({ length: PROFILE_POINTS }, (_, i) => along(a, b, i / (PROFILE_POINTS - 1)));
  const prof: Profile = { key: `${aoiId}|${runId}|${a}|${b}`, dist: pts.map((_, i) => (lenM * i) / (PROFILE_POINTS - 1)), ground: pts.map(() => null),
    depth: pts.map(() => null), t_s: [], lenM, pending: pts.length };
  for (let s = 0; s < pts.length; s += BATCH) {
    if (!live()) return;
    const idx = pts.slice(s, s + BATCH).map((_, k) => s + k);
    await Promise.all(idx.map(async (i) => {
      const [g, ser] = await Promise.all([groundAt(aoiId, pts[i]), getPointSeries(runId, pts[i][0], pts[i][1])]);
      prof.ground[i] = g;
      if (ser) { prof.depth[i] = ser.depth_m; if (!prof.t_s.length) prof.t_s = ser.t_s; }
      prof.pending--;
    }));
    if (!live()) return;
    onPart({ ...prof, ground: [...prof.ground], depth: [...prof.depth] });
  }
}
/** Water surface and ground along the line at one frame. A sample with no ground (outside the model) is skipped. */
export function profileAt(p: Profile, frame: number) {
  const pts: { x: number; ground: number; water: number; depth: number }[] = [];
  p.dist.forEach((x, i) => {
    const g = p.ground[i];
    if (g == null) return;
    const d = p.depth[i]?.[Math.min(frame, (p.depth[i]?.length ?? 1) - 1)] ?? 0;
    const depth = Number.isFinite(d) && d > 0.02 ? d : 0;
    pts.push({ x, ground: g, water: g + depth, depth });
  });
  return pts;
}
