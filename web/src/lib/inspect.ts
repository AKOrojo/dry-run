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
