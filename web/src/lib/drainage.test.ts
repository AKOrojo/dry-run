import { beforeEach, describe, expect, it } from "vitest";
import { adoptDrainage, drainageSpec, drainageStore, fillAt, fillTone, resetDrainage, returnPeriods, setDrainage } from "./drainage";
import type { DrainageDefault } from "./drainage";

const queens = {
  system: "closed", label: "Closed sewers", capacity_mm_h: 38.1, return_period_yr: 3,
  design_mm_h_by_return_period: { "10": 54.1, "3": 38.1, "5": 44.5 }, blockage_pct: 10, blockage_range_pct: [0, 90],
  flap_gates: true, roadside_gutters: false, receiving: "East River", storage_mm: 5, limits: [], sources: ["NYC DEP"],
} as unknown as DrainageDefault;
const lagos = { ...queens, system: "open", capacity_mm_h: 25, return_period_yr: null, design_mm_h_by_return_period: {}, flap_gates: false, roadside_gutters: true } as unknown as DrainageDefault;

describe("drainage card state", () => {
  beforeEach(() => resetDrainage("queens", queens));

  it("sends nothing until the user changes something", () => {
    expect(drainageSpec()).toBeUndefined();
    expect(drainageStore.get().card?.returnPeriod).toBe(3);
  });

  it("sends the whole block with exactly one capacity field", () => {
    setDrainage({ returnPeriod: 10, capacityMmH: 54.1 });
    expect(drainageSpec()).toEqual({ system: "closed", return_period_yr: 10, blockage_pct: 10, outfall: "tide", flap_gates: true, roadside_gutters: false });
    setDrainage({ returnPeriod: null, capacityMmH: 60 });
    const s = drainageSpec()!;
    expect(s.capacity_mm_h).toBe(60);
    expect("return_period_yr" in s).toBe(false);
  });

  it("never sends roadside gutters on a closed system", () => {
    setDrainage({ roadsideGutters: true });
    expect(drainageSpec()?.roadside_gutters).toBe(false);
    setDrainage({ system: "mixed" });
    expect(drainageSpec()?.roadside_gutters).toBe(true);
  });

  it("an area without a design table types the capacity", () => {
    resetDrainage("lagos", lagos);
    expect(returnPeriods(lagos)).toEqual([]);
    setDrainage({ blockagePct: 40 });
    expect(drainageSpec()).toMatchObject({ system: "open", capacity_mm_h: 25, blockage_pct: 40 });
  });

  it("adopts a loaded run's block and resets on null", () => {
    adoptDrainage({ system: "mixed", capacity_mm_h: 30, outfall: "blocked" });
    expect(drainageStore.get().card).toMatchObject({ system: "mixed", returnPeriod: null, capacityMmH: 30, outfall: "blocked", blockagePct: 10 });
    adoptDrainage(null);
    expect(drainageStore.get().touched).toBe(false);
  });
});

describe("fill", () => {
  it("tones by threshold", () => {
    expect(fillTone(null).token).toBe("--ink");
    expect(fillTone(10)).toEqual({ token: "--depth-3", alpha: 0.35 });
    expect(fillTone(79).token).toBe("--depth-3");
    expect(fillTone(80).token).toBe("--danfo");
    expect(fillTone(95).token).toBe("--hazard");
  });

  it("reads the frame nearest the clock", () => {
    const df = { t_s: [0, 600, 1200], ids: ["drain:a", "zone:1"], kind: ["open_drain", "sewer_zone"], fill_pct: [[0, 0], [50, 20], [100, 90]] } as never;
    expect(fillAt(df, 700).get("drain:a")).toBe(50);
    expect(fillAt(df, 1000).get("zone:1")).toBe(90);
  });
});

describe("adopting a run without a capacity field", () => {
  it("keeps the area's design storm", () => {
    resetDrainage("queens", queens);
    adoptDrainage({ blockage_pct: 60, outfall: "blocked" });
    expect(drainageStore.get().card).toMatchObject({ returnPeriod: 3, capacityMmH: 38.1, blockagePct: 60, outfall: "blocked" });
    expect(drainageSpec()).toEqual({ blockage_pct: 60, outfall: "blocked" });
  });
});

describe("an adopted run's block", () => {
  it("is sent back verbatim (same spec, same run_id) until the user edits", () => {
    resetDrainage("queens", queens);
    const partial = { system: "mixed", return_period_yr: 5 } as const;
    adoptDrainage(partial);
    expect(drainageSpec()).toEqual(partial);
    const withNulls = { system: null, capacity_mm_h: null, return_period_yr: null, blockage_pct: 60, outfall: "blocked", flap_gates: null, roadside_gutters: null } as never;
    adoptDrainage(withNulls);
    expect(drainageSpec()).toBe(withNulls);
    setDrainage({ blockagePct: 70 });
    expect(drainageSpec()).toEqual({ system: "closed", return_period_yr: 3, blockage_pct: 70, outfall: "blocked", flap_gates: true, roadside_gutters: false });
  });
});
