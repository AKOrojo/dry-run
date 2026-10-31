import { describe, expect, it } from "vitest";
import { beforeRun } from "./simbar";
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
