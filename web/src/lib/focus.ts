// A request for the map to fly to a point (set by the dock's event list, consumed by the map stage).
import { useSyncExternalStore } from "react";

export type Focus = { lon: number; lat: number } | null;

let state: Focus = null;
const subs = new Set<() => void>();

export const focus = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useFocus = () => useSyncExternalStore(focus.subscribe, focus.get);
export function setFocus(next: Focus) {
  state = next;
  subs.forEach((f) => f());
}
