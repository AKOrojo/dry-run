import { describe, expect, it } from "vitest";
import { runLabel, runLabels, shortIds } from "./runlabel";
import { drainageDiff } from "./drainage";
import type { DrainageDefault } from "./drainage";
import type { RunManifest, ScenarioSpec, Spatial } from "./api";

const lagos = {
  system: "open", label: "Open drains", capacity_mm_h: 25, return_period_yr: null, design_mm_h_by_return_period: {}, blockage_pct: 30,
  blockage_range_pct: [0, 90], flap_gates: false, roadside_gutters: true, receiving: "the lagoon", storage_mm: 5, limits: [],
} as unknown as DrainageDefault;

const run = (run_id: string, sc: Partial<ScenarioSpec> = {}, storm: Partial<ScenarioSpec["storm"]> = {}) =>
  ({ run_id, scenario: { aoi_id: "lagos-lekki-v3", ...sc, storm: { total_mm: 120, duration_h: 3, ...storm } } }) as unknown as RunManifest;

describe("runLabel", () => {
  it("the default storm adds nothing", () => {
    expect(runLabel(run("r_a"), lagos)).toBe("Baseline · 120 mm / 3 h");
    expect(runLabel(run("r_a", { drainage: null }, { pattern: "uniform", spatial: null }), lagos)).toBe("Baseline · 120 mm / 3 h");
  });

  it("adds a time pattern that is not uniform, in the TopBar's words", () => {
    expect(runLabel(run("r_a", {}, { pattern: "front_loaded" }), lagos)).toBe("Baseline · 120 mm / 3 h · front-loaded");
    expect(runLabel(run("r_a", {}, { pattern: "center_peaked" }), lagos)).toBe("Baseline · 120 mm / 3 h · centre-peaked");
  });

  it("adds the rain area when it is not the whole area", () => {
    const cell: Spatial = { kind: "cell", center: [3.5, 6.45], place: null, radius_m: 3000, profile: "gaussian", track: null };
    expect(runLabel(run("r_a", {}, { spatial: cell }), lagos)).toBe("Baseline · 120 mm / 3 h · storm cell");
    expect(runLabel(run("r_a", {}, { spatial: { ...cell!, kind: "cell", track: { heading_deg: 90, speed_m_s: 5 } } as Spatial }), lagos)).toBe("Baseline · 120 mm / 3 h · moving cell");
    expect(runLabel(run("r_a", {}, { spatial: { kind: "polygon", polygon: [[3.5, 6.4], [3.6, 6.4], [3.6, 6.5]], place: null } }), lagos))
      .toBe("Baseline · 120 mm / 3 h · drawn area");
    expect(runLabel(run("r_a", {}, { spatial: { kind: "polygon", polygon: null, place: "Ajah" } }), lagos)).toBe("Baseline · 120 mm / 3 h · Ajah");
  });

  it("a raised sea level is named once, in what the run is", () => {
    expect(runLabel(run("r_a", { interventions: [{ type: "tide", boundary_level_m: 0.3 }] }), lagos)).toBe("Sea level +0.3 m · 120 mm / 3 h");
  });

  it("adds drainage that is not the area's default, in the card's words", () => {
    expect(runLabel(run("r_a", { drainage: { blockage_pct: 60 } }), lagos)).toBe("Baseline · 120 mm / 3 h · 60 % blocked");
  });

  it("all of them together, in order", () => {
    const m = run("r_a", { interventions: [{ type: "tide", boundary_level_m: 0.3 }], drainage: { system: "closed", outfall: "blocked" } },
      { pattern: "front_loaded", spatial: { kind: "polygon", polygon: null, place: "Ajah" } });
    expect(runLabel(m, lagos)).toBe("Sea level +0.3 m · 120 mm / 3 h · front-loaded · Ajah · closed sewer, blocked outfall");
  });
});

describe("drainageDiff", () => {
  it("is null for the default, a block equal to it, or no block", () => {
    expect(drainageDiff(undefined, lagos)).toBeNull();
    expect(drainageDiff({ system: "open", capacity_mm_h: 25, blockage_pct: 30, outfall: "tide", flap_gates: false, roadside_gutters: true }, lagos)).toBeNull();
  });
  it("names each field that differs", () => {
    expect(drainageDiff({ capacity_mm_h: 40, flap_gates: true, roadside_gutters: false, outfall: "free" }, lagos))
      .toBe("drains 40 mm/h, free outfall, flap gates, no roadside gutters");
  });
  it("leaves gutters out on a closed sewer", () => {
    expect(drainageDiff({ system: "closed", roadside_gutters: false }, lagos)).toBe("closed sewer");
  });
  it("says custom drainage when there is no default to compare with", () => {
    expect(drainageDiff({ blockage_pct: 60 }, null)).toBe("custom drainage");
  });
});

describe("runLabels", () => {
  it("two identical scenarios get their short ids", () => {
    const l = runLabels([run("r_1a2b3c4d"), run("r_9f8e7d6c")], lagos);
    expect(l.get("r_1a2b3c4d")).toBe("Baseline · 120 mm / 3 h · r_1a2b");
    expect(l.get("r_9f8e7d6c")).toBe("Baseline · 120 mm / 3 h · r_9f8e");
  });

  it("only the runs that still collide get ids", () => {
    const l = runLabels([run("r_1a2b3c4d"), run("r_1a2b9999"), run("r_5555aaaa", {}, { pattern: "front_loaded" })], lagos);
    expect(l.get("r_1a2b3c4d")).toBe("Baseline · 120 mm / 3 h · r_1a2b3");
    expect(l.get("r_1a2b9999")).toBe("Baseline · 120 mm / 3 h · r_1a2b9");
    expect(l.get("r_5555aaaa")).toBe("Baseline · 120 mm / 3 h · front-loaded");
  });
});

describe("shortIds", () => {
  it("is at least 4 characters after r_, longer only where it must be", () => {
    expect(shortIds(["r_abcdef", "r_abcxyz"])).toEqual(new Map([["r_abcdef", "r_abcd"], ["r_abcxyz", "r_abcx"]]));
    expect(shortIds(["r_abcdef12", "r_abcdef34"])).toEqual(new Map([["r_abcdef12", "r_abcdef1"], ["r_abcdef34", "r_abcdef3"]]));
  });
});
