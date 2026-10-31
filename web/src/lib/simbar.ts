// The Simulate bar before a run: what to say while the scenario is incomplete, while the estimate is on its way (or the
// server is waking from idle), and once it has answered.
import type { SimEstimate } from "./api";
import type { RainMode } from "./rain";

/** An unanswered estimate: "waking" after WAKING_MS (a Cloud Run cold start), "gave up" after GIVE_UP_MS. */
export const WAKING_MS = 2500, GIVE_UP_MS = 20000;
export type EstWait = "waiting" | "waking" | "gaveUp";

export type BeforeRun =
  | { state: "incomplete"; reason: string }
  | { state: "checking" }
  | { state: "waking" }
  | { state: "cached" }
  | { state: "live"; estS: number | null };

const REASON: Partial<Record<RainMode, string>> = {
  draw: "Draw the rain area on the map to simulate.",
  place: "Pick a place to simulate.",
  cell: "Place the storm cell to simulate.",
};

/** `ready`: the scenario is complete (there is a spec to estimate). */
export function beforeRun(ready: boolean, mode: RainMode, est: SimEstimate | "failed" | null, wait: EstWait): BeforeRun {
  if (!ready) return REASON[mode] ? { state: "incomplete", reason: REASON[mode]! } : { state: "checking" };
  if (est === "failed") return { state: "live", estS: null };
  if (est) return est.cached ? { state: "cached" } : { state: "live", estS: est.est_s };
  // No answer yet: say the server is waking, then stop waiting and let Simulate run with the time unknown.
  return wait === "gaveUp" ? { state: "live", estS: null } : wait === "waking" ? { state: "waking" } : { state: "checking" };
}

/** The lock countdown follows the server's eta, which refines in jumps (46 → 29 s). Ease it: never rise, and fall at
 *  most EASE_RATE seconds per second towards the eta. */
export const EASE_RATE = 1.5;
export function easeLeft(shown: number | null, target: number | null, dtS: number): number | null {
  if (target == null) return shown;
  if (shown == null) return target;
  return Math.max(0, Math.max(Math.min(target, shown), shown - EASE_RATE * Math.max(0, dtS)));
}
