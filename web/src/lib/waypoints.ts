// User-dropped waypoints on the map (numbered danfo pins).
import { useSyncExternalStore } from "react";

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
