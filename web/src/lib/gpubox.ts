// The box of the "3D on your GPU" card, shared by the sidebar card and the map (pattern of lib/simstate.ts).
// The card sets size, cell and the picked centre; the map layer (GpuBoxMap) publishes the view centre and handles
// the pick. The solve's run state lives here too, so it survives switching sidebar tabs.
import { useSyncExternalStore } from "react";

export type GpuPhase = "inputs" | "solving" | "encoding";
export type GpuRun = { phase: GpuPhase; fraction: number; startedAt: number };
export type GpuBoxState = {
  /** The card has been opened on a finished run: the map draws the box. */
  shown: boolean;
  /** Picked on the map; null = follow the view centre (or the area centre). */
  centre: [number, number] | null;
  /** The map view centre on the ground, published by the map. */
  view: [number, number] | null;
  /** The area's bounds [w, s, e, n], set by the card: a view centre outside them falls back to the area centre. */
  bounds: [number, number, number, number] | null;
  size_m: number;
  cell_m: number;
  /** The next left click on the map sets the centre; Esc cancels. */
  picking: boolean;
  /** The solve in progress, or null. */
  run: GpuRun | null;
  error: string | null;
};

let state: GpuBoxState = { shown: false, centre: null, view: null, bounds: null, size_m: 200, cell_m: 1, picking: false, run: null, error: null };
const subs = new Set<() => void>();
export const gpubox = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useGpuBox = () => useSyncExternalStore(gpubox.subscribe, gpubox.get);
export function setGpuBox(patch: Partial<GpuBoxState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

/** The box centre: the picked point, else the view centre while it is inside the area, else the area centre. */
export function boxCentre(s: GpuBoxState): [number, number] | null {
  if (s.centre) return s.centre;
  const b = s.bounds;
  if (!b) return s.view;
  if (s.view && s.view[0] >= b[0] && s.view[0] <= b[2] && s.view[1] >= b[1] && s.view[1] <= b[3]) return s.view;
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** The running solve's controller; aborting it makes solvePatchInBrowser reject. */
let ctl: AbortController | null = null;
export const setSolveController = (c: AbortController | null) => { ctl = c; };
export const abortSolve = () => { ctl?.abort(); };
