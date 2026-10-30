// Values under the map cursor. The map (MapStage) fills this; the Inspect tab reads it.
import { useSyncExternalStore } from "react";

export type Inspect = {
  lon: number | null; lat: number | null; depth_m: number | null; max_m: number | null;
  wet_t: number | null; impassable_t: number | null;
};
const EMPTY: Inspect = { lon: null, lat: null, depth_m: null, max_m: null, wet_t: null, impassable_t: null };
let state: Inspect = EMPTY;
const subs = new Set<() => void>();

export const inspect = {
  get: () => state,
  set: (p: Partial<Inspect>) => { state = { ...state, ...p }; subs.forEach((f) => f()); },
  clear: () => { state = EMPTY; subs.forEach((f) => f()); },
  subscribe: (f: () => void) => { subs.add(f); return () => subs.delete(f); },
};
export const useInspect = () => useSyncExternalStore(inspect.subscribe, inspect.get);
