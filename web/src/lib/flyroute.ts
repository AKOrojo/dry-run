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

/** Whether the water-below-the-camera series should be fetched at `at`: only inside the area's bounds [w, s, e, n]
 *  (the HUD starts at [0, 0], and a camera over the sea has no series) and once it is ~60 m from the last fetch. */
export function belowFetchDue(at: LonLat, prev: LonLat | null, bounds: readonly number[] | undefined): boolean {
  const [lon, lat] = at;
  if (!bounds || lon < bounds[0] || lon > bounds[2] || lat < bounds[1] || lat > bounds[3]) return false;
  return !prev || Math.hypot((lon - prev[0]) * 111320 * Math.cos((lat * Math.PI) / 180), (lat - prev[1]) * 110540) >= 60;
}
