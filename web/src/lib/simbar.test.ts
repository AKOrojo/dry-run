import { describe, expect, it } from "vitest";
import { beforeRun, easeLeft, runningTotal } from "./simbar";
import type { SimEstimate } from "./api";

const est = (cached: boolean) => ({ run_id: "r_x", cached, status: cached ? "done" : "none", est_s: 160 } as unknown as SimEstimate);

describe("Simulate bar before a run", () => {
  it("says what is missing instead of checking the cache when there is no spec", () => {
    expect(beforeRun(false, "draw", null, "waiting")).toEqual({ state: "incomplete", reason: "Draw the rain area on the map to simulate." });
    expect(beforeRun(false, "place", null, "gaveUp")).toEqual({ state: "incomplete", reason: "Pick a place to simulate." });
    expect(beforeRun(false, "cell", null, "waking")).toEqual({ state: "incomplete", reason: "Place the storm cell to simulate." });
  });

  it("checks, then says the server is waking, then gives up waiting", () => {
    expect(beforeRun(true, "whole", null, "waiting")).toEqual({ state: "checking" });
    expect(beforeRun(true, "whole", null, "waking")).toEqual({ state: "waking" });
    expect(beforeRun(true, "whole", null, "gaveUp")).toEqual({ state: "live", estS: null });
  });

  it("an answer wins over the wait", () => {
    expect(beforeRun(true, "draw", est(true), "waking")).toEqual({ state: "cached" });
    expect(beforeRun(true, "draw", est(false), "gaveUp")).toEqual({ state: "live", estS: 160 });
    expect(beforeRun(true, "cell", "failed", "waiting")).toEqual({ state: "live", estS: null });
  });
});

describe("lock countdown easing", () => {
  it("never rises and falls at most 1.5 s per second towards the eta", () => {
    expect(easeLeft(null, 46, 1)).toBe(46);
    expect(easeLeft(46, 29, 1)).toBe(44.5);
    expect(easeLeft(44.5, 50, 1)).toBe(44.5);
    expect(easeLeft(30, 29.5, 1)).toBe(29.5);
    expect(easeLeft(1, 0, 10)).toBe(0);
    expect(easeLeft(20, null, 1)).toBe(20);
  });
});

describe("Simulate bar while running", () => {
  it("never shows a total below the elapsed time after a queued run starts solving", () => {
    // Waited 60 s in the queue, then solving for 10 s: the server's elapsed_s restarted at 0, its eta is 20 s.
    const elapsedS = 70, serverElapsed = 10, eta = 20;
    const total = runningTotal(elapsedS, eta, null)!;
    expect(total).toBeGreaterThanOrEqual(elapsedS);
    expect(total).toBe(90);
    expect(serverElapsed + eta).toBeLessThan(elapsedS);  // the old sum
  });
  it("keeps the started estimate until the server sends an eta", () => {
    expect(runningTotal(5, null, 120)).toBe(120);
    expect(runningTotal(5, undefined, null)).toBeNull();
  });
  it("eases a queue wait that jumps up", () => {
    expect(easeLeft(26, 33, 1)).toBe(26);   // never rises
    expect(easeLeft(54, 20, 2)).toBe(51);   // falls at most 1.5 s per second
  });
});
