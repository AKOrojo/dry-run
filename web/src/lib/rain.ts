// Where the rain falls: the editing state, the live preview of the rain field, and helpers shared by the
// sidebar, map, dock and top bar (pattern of lib/waypoints.ts). Persisted per area in localStorage.
import { useEffect, useSyncExternalStore } from "react";
import { ApiError, getRainField } from "./api";
import type { RainField, RainProfile, Spatial, Storm } from "./api";

export type RainMode = "whole" | "cell" | "draw" | "place";
export type LonLat = [number, number];
export type RainPlace = { name: string; lon: number; lat: number; ring: LonLat[] };
type Pattern = NonNullable<Storm["pattern"]>;

export type RainState = {
  aoiId: string | null; bounds: [number, number, number, number] | null; lagos: boolean;
  mode: RainMode; center: LonLat | null; radius_m: number; profile: RainProfile;
  moving: boolean; heading_deg: number; speed_m_s: number;
  polygon: LonLat[] | null; place: string | null; placeAsCell: boolean;
  /** The map is waiting for a click on the centre, or for polygon vertices. */
  picking: null | "centre" | "polygon";
  preview: RainField | null; previewBusy: boolean; previewErr: string | null;
  places: RainPlace[];
  /** Set by App: the preview is on the map (no finished run for this storm, or the layer is switched on). */
  visible: boolean;
  /** Key of the storm the last Simulate sent; once it matches the current storm the water layers take over. */
  lastSimKey: string | null;
};

const DEFAULT: RainState = {
  aoiId: null, bounds: null, lagos: false, mode: "whole", center: null, radius_m: 5000, profile: "gaussian",
  moving: false, heading_deg: 90, speed_m_s: 5, polygon: null, place: null, placeAsCell: false, picking: null,
  preview: null, previewBusy: false, previewErr: null, places: [], visible: false, lastSimKey: null,
};
let state: RainState = DEFAULT;
const subs = new Set<() => void>();
export const rain = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useRain = () => useSyncExternalStore(rain.subscribe, rain.get);

const KEY = (id: string) => `dr_rain_${id}`;
const PERSIST = ["mode", "center", "radius_m", "profile", "moving", "heading_deg", "speed_m_s", "polygon", "place", "placeAsCell"] as const;
function persist() {
  if (!state.aoiId) return;
  try { localStorage.setItem(KEY(state.aoiId), JSON.stringify(Object.fromEntries(PERSIST.map((k) => [k, state[k]])))); } catch { /* storage blocked */ }
}
export function setRain(patch: Partial<RainState>) {
  state = { ...state, ...patch };
  if (PERSIST.some((k) => k in patch)) persist();
  subs.forEach((f) => f());
}

/** Load the saved rain area for an AOI (or the per-area defaults). Lagos: a squall line moving west at 12 m/s. */
export function initRain(aoiId: string, bounds: [number, number, number, number]) {
  const lagos = aoiId.startsWith("lagos");
  let saved: Partial<RainState> = {};
  try { saved = JSON.parse(localStorage.getItem(KEY(aoiId)) ?? "{}") ?? {}; } catch { /* nothing saved */ }
  const okPt = (p: unknown): p is LonLat => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  state = {
    ...DEFAULT, aoiId, bounds, lagos, places: [], lastSimKey: null,
    heading_deg: lagos ? 265 : 90, speed_m_s: lagos ? 12 : 5,
    ...(["whole", "cell", "draw", "place"].includes(saved.mode as string) ? { mode: saved.mode } : {}),
    ...(okPt(saved.center) ? { center: saved.center } : {}),
    ...(typeof saved.radius_m === "number" ? { radius_m: Math.min(15000, Math.max(1000, saved.radius_m)) } : {}),
    ...(["gaussian", "exponential", "flat"].includes(saved.profile as string) ? { profile: saved.profile } : {}),
    ...(typeof saved.moving === "boolean" ? { moving: saved.moving } : {}),
    ...(typeof saved.heading_deg === "number" ? { heading_deg: ((saved.heading_deg % 360) + 360) % 360 } : {}),
    ...(typeof saved.speed_m_s === "number" ? { speed_m_s: Math.min(20, Math.max(0, saved.speed_m_s)) } : {}),
    ...(Array.isArray(saved.polygon) && saved.polygon.length >= 3 && saved.polygon.every(okPt) ? { polygon: saved.polygon } : {}),
    ...(typeof saved.place === "string" ? { place: saved.place } : {}),
    ...(typeof saved.placeAsCell === "boolean" ? { placeAsCell: saved.placeAsCell } : {}),
  } as RainState;
  if (state.mode === "cell" && !state.center) state.center = areaCentre(bounds);
  subs.forEach((f) => f());
}

const areaCentre = (b: [number, number, number, number]): LonLat => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

export function setRainMode(mode: RainMode) {
  const s = state;
  setRain({
    mode, picking: null,
    ...(mode === "cell" && !s.center && s.bounds ? { center: areaCentre(s.bounds) } : {}),
    ...(mode === "place" && !s.place && s.places.length ? { place: s.places[0].name } : {}),
  });
}
export function setMoving(on: boolean) { setRain({ moving: on }); }

/** The storm.spatial for the current state, and whether it is complete enough to send. */
export function spatialOf(s: RainState = state): { spatial: Spatial; ready: boolean } {
  const track = s.moving ? { heading_deg: Math.round(s.heading_deg * 10) / 10 % 360, speed_m_s: Math.round(s.speed_m_s * 10) / 10 } : null;
  const cell = { radius_m: Math.round(s.radius_m), profile: s.profile, track };
  if (s.mode === "cell" && s.center) return { spatial: { kind: "cell", center: [round5(s.center[0]), round5(s.center[1])], place: null, ...cell }, ready: true };
  if (s.mode === "draw") {
    const ok = !!s.polygon && s.polygon.length >= 3;
    return { spatial: { kind: "polygon", polygon: ok ? s.polygon!.map((p) => [round5(p[0]), round5(p[1])] as LonLat) : null, place: null }, ready: ok };
  }
  if (s.mode === "place" && s.place) {
    return { spatial: s.placeAsCell ? { kind: "cell", center: null, place: s.place, ...cell } : { kind: "polygon", polygon: null, place: s.place }, ready: true };
  }
  return { spatial: null, ready: s.mode === "whole" };
}
const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

export const buildStorm = (total_mm: number, duration_h: number, pattern: Pattern, spatial: Spatial): Storm =>
  ({ total_mm, duration_h, pattern, ...(spatial ? { spatial } : {}) });
export const stormKey = (total_mm: number, duration_h: number, pattern: Pattern, spatial: Spatial) =>
  JSON.stringify([total_mm, duration_h, pattern, spatial]);

/** Is the rain an effective cell (explicit centre, or a place used as the centre)? */
export const isCell = (s: RainState) => (s.mode === "cell" && !!s.center) || (s.mode === "place" && s.placeAsCell && !!s.place);
export const effectiveCentre = (s: RainState): LonLat | null => (s.mode === "cell" ? s.center : s.mode === "place" && s.placeAsCell ? s.preview?.center ?? null : null);

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compassOf = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** Top bar text after the "120 mm / 3 h": null means "use the pattern text". */
export function rainSummary(s: RainState): string | null {
  const km = `${+(s.radius_m / 1000).toFixed(1)} km`;
  const mv = s.moving ? `, moving ${compassOf(s.heading_deg)}` : "";
  if (s.mode === "cell") return `storm cell, ${km}${mv}`;
  if (s.mode === "draw") return "inside a drawn area";
  if (s.mode === "place" && s.place) return s.placeAsCell ? `storm cell at ${s.place}, ${km}${mv}` : `inside ${s.place}`;
  return null;
}

// ---- time pattern: the same hyetograph the backend uses (dryrun/sim/interventions.py rain_rate_mm_h) ----
export function hyetograph(total_mm: number, duration_h: number, pattern: Pattern, n = 37): number[] {
  const mean = total_mm / duration_h;
  return Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    return pattern === "front_loaded" ? mean * 2 * (1 - x) : pattern === "center_peaked" ? mean * (2 - 4 * Math.abs(x - 0.5)) : mean;
  });
}
/** Hours into the storm at which a moving cell is at `center` (its peak intensity). */
export const peakHours = (duration_h: number, pattern: Pattern) => (pattern === "front_loaded" ? 0 : duration_h / 2);

/** Metres east/north of a point to lon/lat (local equirectangular approximation). */
export function offsetLL(p: LonLat, eastM: number, northM: number): LonLat {
  return [p[0] + eastM / (111320 * Math.cos((p[1] * Math.PI) / 180)), p[1] + northM / 110540];
}
export function metresBetween(a: LonLat, b: LonLat): { east: number; north: number; dist: number } {
  const east = (b[0] - a[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), north = (b[1] - a[1]) * 110540;
  return { east, north, dist: Math.hypot(east, north) };
}
/** Track of a moving cell: the centre at peak time, ends at t=0 and t=duration. Each end is clipped to `clipM` from the centre. */
export function trackEnds(center: LonLat, heading_deg: number, speed_m_s: number, duration_h: number, pattern: Pattern, clipM: number) {
  const h = (heading_deg * Math.PI) / 180, pk = peakHours(duration_h, pattern);
  const at = (t_h: number) => {
    const d = Math.max(-clipM, Math.min(clipM, speed_m_s * (t_h - pk) * 3600));
    return offsetLL(center, d * Math.sin(h), d * Math.cos(h));
  };
  const reach = (t_h: number) => speed_m_s * Math.abs(t_h - pk) * 3600;
  return { start: at(0), end: at(duration_h), startM: reach(0), endM: reach(duration_h) };
}

// ---- live preview ----
/** Debounced (about 4 requests a second at most), cancels the stale request, keeps the last good preview while loading. */
export function useRainPreview(aoiId: string | undefined, total_mm: number, duration_h: number, pattern: Pattern) {
  const s = useRain();
  const { spatial, ready } = spatialOf(s);
  const body = spatial ? JSON.stringify(buildStorm(total_mm, duration_h, pattern, spatial)) : "";
  useEffect(() => {
    if (!aoiId || !body || !ready) { setRain({ preview: null, previewBusy: false, previewErr: null }); return; }
    const ctl = new AbortController();
    setRain({ previewBusy: true });
    const timer = setTimeout(() => {
      getRainField(aoiId, JSON.parse(body) as Storm, ctl.signal).then(
        (f) => { if (!ctl.signal.aborted) setRain({ preview: f, previewBusy: false, previewErr: null }); },
        (e) => {
          if (ctl.signal.aborted) return;
          setRain({ previewBusy: false, previewErr: e instanceof ApiError ? e.message : "The rain preview is not available." });
        });
    }, 260);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [aoiId, body, ready]);
}

// ---- depth inside each place, from the preview PNG ----
const loaded = new Map<string, Promise<ImageData>>();
function pixels(png: string): Promise<ImageData> {
  let p = loaded.get(png);
  if (!p) {
    p = new Promise((ok, bad) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement("canvas");
        c.width = im.naturalWidth; c.height = im.naturalHeight;
        const g = c.getContext("2d", { willReadFrequently: true });
        if (!g) { bad(new Error("no canvas")); return; }
        g.drawImage(im, 0, 0);
        ok(g.getImageData(0, 0, c.width, c.height));
      };
      im.onerror = bad;
      im.src = png;
    });
    loaded.set(png, p);
    if (loaded.size > 6) loaded.delete(loaded.keys().next().value as string);
  }
  return p;
}
const inRing = (x: number, y: number, ring: LonLat[]) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
/** Mean preview depth (mm) inside each place: depth is alpha / max_alpha x vmax_mm. */
export async function depthByPlace(f: RainField, places: RainPlace[]): Promise<{ name: string; mm: number }[]> {
  const img = await pixels(f.png);
  const [w, s, e, n] = f.bounds_wgs84;
  return places.map((p) => {
    const xs = p.ring.map((q) => q[0]), ys = p.ring.map((q) => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    let sum = 0, cnt = 0;
    const N = 24;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const lon = x0 + ((x1 - x0) * (i + 0.5)) / N, lat = y0 + ((y1 - y0) * (j + 0.5)) / N;
      if (!inRing(lon, lat, p.ring)) continue;
      const px = Math.floor(((lon - w) / (e - w)) * img.width), py = Math.floor(((n - lat) / (n - s)) * img.height);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      sum += (img.data[(py * img.width + px) * 4 + 3] / 255 / (f.max_alpha || 1)) * f.vmax_mm;
      cnt++;
    }
    return { name: p.name, mm: cnt ? sum / cnt : 0 };
  }).sort((a, b) => b.mm - a.mm);
}
