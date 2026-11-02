// The map point under the cursor (or pinned). Written by the map stage, read by the sidebar.
import { useSyncExternalStore } from "react";

export type Inspect = {
  lon: number; lat: number; depth_m: number; max_m: number;
  wet_t: number | null; impassable_t: number | null;
} | null;

let state: Inspect = null;
const subs = new Set<() => void>();

export const inspect = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useInspect = () => useSyncExternalStore(inspect.subscribe, inspect.get);
export function setInspect(next: Inspect) {
  state = next;
  subs.forEach((f) => f());
}

// Depth series (one value per frame) of the pinned point, for the dock chart.
let pinSeries: number[] | null = null;
const pinSubs = new Set<() => void>();
export const pinnedSeries = {
  get: () => pinSeries,
  subscribe: (f: () => void) => { pinSubs.add(f); return () => { pinSubs.delete(f); }; },
};
export const usePinnedSeries = () => useSyncExternalStore(pinnedSeries.subscribe, pinnedSeries.get);
export function setPinnedSeries(next: number[] | null) {
  pinSeries = next;
  pinSubs.forEach((f) => f());
}

// The pinned point alone (not the hover), for cards that act on a picked spot (street picture), and a way for them to
// clear the pin ("Pick another spot").
let pinnedSpot: { lon: number; lat: number } | null = null;
const spotSubs = new Set<() => void>();
const unpinSubs = new Set<() => void>();
export const usePinnedSpot = () => useSyncExternalStore((f) => { spotSubs.add(f); return () => { spotSubs.delete(f); }; }, () => pinnedSpot);
export function setPinnedSpot(next: { lon: number; lat: number } | null) {
  if (next?.lon === pinnedSpot?.lon && next?.lat === pinnedSpot?.lat) return;
  pinnedSpot = next;
  spotSubs.forEach((f) => f());
}
export const requestUnpin = () => unpinSubs.forEach((f) => f());
export const onUnpinRequest = (f: () => void) => { unpinSubs.add(f); return () => { unpinSubs.delete(f); }; };
