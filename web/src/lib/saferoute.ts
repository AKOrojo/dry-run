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

/** Same polyline (to about a metre): the dry route did not have to leave the usual one. */
export function samePath(a: Spot[] | undefined, b: Spot[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-5 && Math.abs(p[1] - b[i][1]) < 1e-5);
}

/** The card's "To" line: the shelter's name says "shelter" once. */
export const shelterName = (name: string | null | undefined) => (!name ? "Nearest shelter" : /shelter/i.test(name) ? name : `${name} (shelter)`);

const R = 6378137;
const segM = (a: Spot, b: Spot) => {
  const lat = ((a[1] + b[1]) / 2) * Math.PI / 180;
  return Math.hypot((b[0] - a[0]) * Math.PI / 180 * Math.cos(lat) * R, (b[1] - a[1]) * Math.PI / 180 * R);
};

/** Points every `stepM` along a polyline (at least `min`, at most `max`), ends included. */
export function samplePath(path: Spot[], stepM: number, min: number, max: number): Spot[] {
  if (path.length < 2) return path.slice();
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + segM(path[i - 1], path[i]));
  const len = cum[cum.length - 1], n = Math.min(max, Math.max(min, Math.ceil(len / stepM) + 1));
  const out: Spot[] = [];
  for (let k = 0, i = 1; k < n; k++) {
    const d = (len * k) / (n - 1);
    while (i < path.length - 1 && cum[i] < d) i++;
    const f = cum[i] > cum[i - 1] ? (d - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
    out.push([path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f]);
  }
  return out;
}

/** One mark per stretch of consecutive wet samples, at its middle sample. */
export function wetRuns(samples: Spot[], wet: boolean[]): Spot[] {
  const out: Spot[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (!wet[i]) continue;
    let j = i;
    while (j + 1 < samples.length && wet[j + 1]) j++;
    out.push(samples[Math.floor((i + j) / 2)]);
    i = j;
  }
  return out;
}

/** The card's error line for a failed /api/route (an ApiError or a message): the hourly limit (429) says when to try
 *  again from its Retry-After, "more than N m from any road" is said in plain words, anything else is a short failure. */
export const routeError = (e: unknown) => {
  const err = (e ?? {}) as { status?: number; retryAfterS?: number; message?: string };
  if (err.status === 429) {
    const min = err.retryAfterS ? Math.max(1, Math.ceil(err.retryAfterS / 60)) : null;
    // A day-long wait is the service-wide daily cap, not this connection's hourly one.
    if (min != null && min >= 20 * 60) return "Routes are paused for today across the service. Try again tomorrow.";
    const when = min == null ? "in a few minutes" : min < 45 ? `in ${min} min` : min < 90 ? "in about an hour" : `in about ${Math.round(min / 60)} hours`;
    return `Too many routes asked for from this connection. Try again ${when}.`;
  }
  const msg = typeof e === "string" ? e : err.message ?? "";
  return /from any road/i.test(msg) ? "This spot is too far from a road. Pick one on or near a street."
    : "The route could not be worked out. Try again, or pick another start.";
};

/** The usual route is "now cut" only when the dry route had to leave it, or there is no dry route. */
export const usualCut = (route: RouteResult | null, usual: RouteResult | null) =>
  !!usual?.reachable && !!route && (!route.reachable || !samePath(route.path, usual.path));
