// Safe route (board 12): the dry route from a picked spot to the nearest shelter, for the frame the playhead is on.
// The store holds what the map and the Inspect card show; MapStage fills it (it owns the viewer and the run).
import { useSyncExternalStore } from "react";
import type { RouteResult } from "../contracts/gen/RouteResult";

export type Spot = [number, number];

export type SafeRouteState = {
  origin: Spot | null;
  /** The next click on the map sets the start ("Pick another start"). */
  picking: boolean;
  /** Frame time (s) the route below is for: the frame nearest the playhead. */
  t: number | null;
  route: RouteResult | null;
  /** The usual route at the dry start of the run (t = 0): the dashed line "now cut". */
  usual: RouteResult | null;
  /** Points on the usual route that are under water at `t` (approximate road cuts, for the map marks). */
  blocked: Spot[];
  /** First later frame with a dry route, when none is dry at `t`; null when none is found. */
  clearT: number | null;
  loading: boolean;
  error: string | null;
};

const EMPTY: SafeRouteState = { origin: null, picking: false, t: null, route: null, usual: null, blocked: [], clearT: null, loading: false, error: null };

let state: SafeRouteState = EMPTY;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const safeRoute = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useSafeRoute = () => useSyncExternalStore(safeRoute.subscribe, safeRoute.get);

/** A new start: everything from the previous start is dropped at once. */
export function startSafeRoute(origin: Spot) { state = { ...EMPTY, origin }; emit(); }
export function clearSafeRoute() { state = EMPTY; emit(); }
export function setSafeRoute(patch: Partial<SafeRouteState>) { state = { ...state, ...patch }; emit(); }

/** The frame time nearest `t` (the route is worked out per frame), or null without frames. */
export function nearestFrame(times: number[], t: number): number | null {
  if (!times.length) return null;
  let best = times[0];
  for (const f of times) if (Math.abs(f - t) < Math.abs(best - t)) best = f;
  return best;
}

/** The frame times after `t`, in order. */
export function framesAfter(times: number[], t: number): number[] {
  return times.filter((f) => f > t).sort((a, b) => a - b);
}

/** The first frame after `t` whose route is dry, probing one frame at a time; at most `limit` probes. */
export async function firstDryAfter(times: number[], t: number, dryAt: (f: number) => Promise<boolean>, signal: AbortSignal, limit = 60): Promise<number | null> {
  for (const f of framesAfter(times, t).slice(0, limit)) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (await dryAt(f)) return f;
  }
  return null;
}

/** Distance as the card and the map label show it: 3.4 km. */
export const fmtKm = (km: number) => `${km.toFixed(1)} km`;
/** Walking time at 4 km/h, rounded to whole minutes: about 11 min. */
export const fmtEta = (min: number) => `about ${Math.max(1, Math.round(min))} min`;
