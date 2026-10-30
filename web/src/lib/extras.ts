// Rev 5 read-only data for the current run and area (events, lagoon/sea edge, river inflows).
// Loaded once by App, read by the dock, map stage and sidebar. Null means the server has none (yet).
import { useSyncExternalStore } from "react";
import type { BoundaryCollection, InflowCollection, RunEvents } from "./api";

export type Extras = { events: RunEvents | null; boundary: BoundaryCollection | null; inflows: InflowCollection | null };

let state: Extras = { events: null, boundary: null, inflows: null };
const subs = new Set<() => void>();

export const extras = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useExtras = () => useSyncExternalStore(extras.subscribe, extras.get);
export function setExtras(patch: Partial<Extras>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
