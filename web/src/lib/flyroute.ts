// The user's drawn route for the fly-along camera, persisted in localStorage, plus the
// evacuation route line (set by whichever layer loads it) so it can be reused as a flight path.
import { useSyncExternalStore } from "react";

export type LonLat = [number, number];

const KEY = "dryrun.flyroute.v1";

function load(): LonLat[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const pts = raw.filter((p): p is LonLat => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    return pts.length >= 2 ? pts : [];
  } catch { return []; }
}
function save(pts: LonLat[]) {
  try { localStorage.setItem(KEY, JSON.stringify(pts)); } catch { /* storage unavailable */ }
}

let state: LonLat[] = load();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const flyRoute = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useFlyRoute = () => useSyncExternalStore(flyRoute.subscribe, flyRoute.get);

export function setFlyRoute(pts: LonLat[]) { state = pts.length >= 2 ? pts.map((p): LonLat => [p[0], p[1]]) : []; save(state); emit(); }
export function clearFlyRoute() { setFlyRoute([]); }

let evac: LonLat[] | null = null;
const evacSubs = new Set<() => void>();
export const evacLine = {
  get: () => evac,
  subscribe: (f: () => void) => { evacSubs.add(f); return () => { evacSubs.delete(f); }; },
};
export const useEvacLine = () => useSyncExternalStore(evacLine.subscribe, evacLine.get);
export function setEvacLine(pts: LonLat[] | null) { evac = pts && pts.length >= 2 ? pts : null; evacSubs.forEach((f) => f()); }

/** Where the camera's ground point `at` is against the area's bounds [w, s, e, n]. "unknown" until the bounds load,
 *  and for the fly HUD's [0, 0] placeholder before its first real position. Sea or lagoon inside the bounds is "in".
 *  Matches the series route: the point is rounded to 4 decimals as it is sent, and the grid's east and south edges
 *  are outside it (the cell index there is nx or ny). */
export function belowWhere(at: LonLat, bounds: readonly number[] | undefined): "in" | "out" | "unknown" {
  if (!bounds || (at[0] === 0 && at[1] === 0)) return "unknown";
  const lon = Number(at[0].toFixed(4)), lat = Number(at[1].toFixed(4));
  return lon >= bounds[0] && lon < bounds[2] && lat > bounds[1] && lat <= bounds[3] ? "in" : "out";
}

/** Whether the water-below-the-camera series should be fetched at `at`: only inside the area's bounds (off the grid
 *  there is no series) and once it is ~60 m from the last fetch. */
export function belowFetchDue(at: LonLat, prev: LonLat | null, bounds: readonly number[] | undefined): boolean {
  if (belowWhere(at, bounds) !== "in") return false;
  const [lon, lat] = at;
  return !prev || Math.hypot((lon - prev[0]) * 111320 * Math.cos((lat * Math.PI) / 180), (lat - prev[1]) * 110540) >= 60;
}
