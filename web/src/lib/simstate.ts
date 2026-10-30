// Run state of the current Simulate call, for the map (clouds and rain), the dock and the sidebar
// (pattern of lib/rain.ts). App sets it when Simulate starts and ends; progress and modelT can be
// filled in from the server as the run reports them.
import { useSyncExternalStore } from "react";
import type { Storm } from "./api";

export type SimState = {
  running: boolean;
  /** Date.now() when Simulate was pressed. */
  startedAt: number | null;
  /** Expected wall-clock seconds for this run (40 when unknown). */
  estS: number | null;
  /** 0..1 reported by the server, or null while unknown. */
  progress: number | null;
  /** Model time reached, in seconds, or null while unknown (the map then estimates it from elapsed / estS). */
  modelT: number | null;
  storm: Storm | null;
};

const IDLE: SimState = { running: false, startedAt: null, estS: null, progress: null, modelT: null, storm: null };
let state: SimState = IDLE;
const subs = new Set<() => void>();
export const sim = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useSim = () => useSyncExternalStore(sim.subscribe, sim.get);
export function setSim(patch: Partial<SimState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
/** Back to idle (also drops the storm). */
export const resetSim = () => setSim(IDLE);

/** Model hours a run covers when the scenario does not say (the timeline is T+00:00 to T+06:00). */
export const SIM_HOURS = 6;
