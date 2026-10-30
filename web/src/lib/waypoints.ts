// User-dropped waypoints on the map (numbered danfo pins).
import { useSyncExternalStore } from "react";
import type { PointInfo, PointSeries } from "./api";

export type Waypoint = { id: number; n: number; lon: number; lat: number };

let state: Waypoint[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const waypoints = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useWaypoints = () => useSyncExternalStore(waypoints.subscribe, waypoints.get);

export function addWaypoint(lon: number, lat: number): Waypoint {
  const n = state.reduce((m, w) => Math.max(m, w.n), 0) + 1;
  const w = { id: nextId++, n, lon, lat };
  state = [...state, w];
  emit();
  return w;
}
export function removeWaypoint(id: number) {
  state = state.filter((w) => w.id !== id);
  emit();
}
export function clearWaypoints() { state = []; emit(); }

// Per-waypoint readings for the Inspect list, written by the map stage (it already fetches them for the pins).
/** undefined = still loading, null = not available. `series`/`depth_m`/`building_max_m` only exist with a finished run. */
export type WaypointInfo = {
  point?: PointInfo | null; hasRun: boolean;
  depth_m?: number; series?: PointSeries | null; building_max_m?: number | null;
};
let info: Record<number, WaypointInfo> = {};
const infoSubs = new Set<() => void>();
export const waypointInfo = {
  get: () => info,
  subscribe: (f: () => void) => { infoSubs.add(f); return () => { infoSubs.delete(f); }; },
};
export const useWaypointInfo = () => useSyncExternalStore(waypointInfo.subscribe, waypointInfo.get);
export function setWaypointInfo(next: Record<number, WaypointInfo>) {
  info = next;
  infoSubs.forEach((f) => f());
}
