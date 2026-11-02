import { describe, expect, it } from "vitest";
import { pickPair } from "./compare";
import type { RunManifest } from "./api";

const run = (run_id: string, opts: { iv?: boolean; mm?: number } = {}) =>
  ({ run_id, scenario: { aoi_id: "lagos-lekki-v3", storm: { total_mm: opts.mm ?? 120, duration_h: 3 }, interventions: opts.iv ? [{ type: "tide", boundary_level_m: 0.3 }] : [] } }) as unknown as RunManifest;

describe("pickPair", () => {
  const base = run("r_base"), sea = run("r_sea", { iv: true });

  it("keeps a chosen pair that is on offer", () => {
    expect(pickPair([sea, base], { a: "r_sea", b: "r_base" })).toEqual({ a: "r_sea", b: "r_base" });
  });

  it("by default compares the latest change (B) against its baseline (A)", () => {
    expect(pickPair([sea, base], {})).toEqual({ a: "r_base", b: "r_sea" });
  });

  it("a run simulated here keeps that default even while it is on screen", () => {
    expect(pickPair([sea, base], {}, { id: "r_sea", fromElsewhere: false })).toEqual({ a: "r_base", b: "r_sea" });
  });

  it("a run opened from a link is A when no A is chosen, against its baseline", () => {
    const link = run("r_link", { iv: true });
    expect(pickPair([sea, base, link], {}, { id: "r_link", fromElsewhere: true })).toEqual({ a: "r_link", b: "r_base" });
  });

  it("a linked run with no baseline of its storm goes against the latest other run", () => {
    const link = run("r_link", { iv: true, mm: 80 });
    expect(pickPair([sea, base, link], {}, { id: "r_link", fromElsewhere: true })).toEqual({ a: "r_link", b: "r_sea" });
  });

  it("a linked run alone has no B yet", () => {
    expect(pickPair([run("r_link", { iv: true })], {}, { id: "r_link", fromElsewhere: true })).toEqual({ a: "r_link", b: undefined });
  });

  it("with an A already chosen, the linked run does not take A (the default pair fills in)", () => {
    const link = run("r_link", { iv: true });
    expect(pickPair([sea, base, link], { a: "r_sea" }, { id: "r_link", fromElsewhere: true })).toEqual({ a: "r_base", b: "r_sea" });
  });

  it("a linked run from another area is not offered, so it is not picked", () => {
    expect(pickPair([sea, base], {}, { id: "r_elsewhere", fromElsewhere: true })).toEqual({ a: "r_base", b: "r_sea" });
  });
});
