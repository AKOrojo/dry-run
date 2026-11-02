import { describe, expect, it } from "vitest";
import { pickPair } from "./compare";
import type { RunManifest } from "./api";

const run = (run_id: string, opts: { iv?: boolean; mm?: number } = {}) =>
  ({ run_id, scenario: { aoi_id: "lagos-lekki-v3", storm: { total_mm: opts.mm ?? 120, duration_h: 3 }, interventions: opts.iv ? [{ type: "tide", boundary_level_m: 0.3 }] : [] } }) as unknown as RunManifest;
const link = (id: string) => ({ id, fromElsewhere: true });

describe("pickPair", () => {
  const base = run("r_base"), sea = run("r_sea", { iv: true });

  it("keeps a chosen pair that is on offer", () => {
    expect(pickPair([sea, base], { a: "r_sea", b: "r_base" })).toEqual({ a: "r_sea", b: "r_base" });
  });

  describe("runs simulated here (unchanged default)", () => {
    it("B is the latest change, A its baseline", () => {
      expect(pickPair([sea, base], {})).toEqual({ a: "r_base", b: "r_sea" });
    });
    it("the run on screen does not move them", () => {
      expect(pickPair([sea, base], {}, { id: "r_base", fromElsewhere: false })).toEqual({ a: "r_base", b: "r_sea" });
    });
  });

  describe("a run on screen from a link or the agent", () => {
    it("with a change, it is B against its baseline", () => {
      const l = run("r_link", { iv: true });
      expect(pickPair([sea, base, l], {}, link("r_link"))).toEqual({ a: "r_base", b: "r_link" });
    });
    it("a baseline, it is A against the latest change on its storm", () => {
      const l = run("r_link"), other = run("r_other", { iv: true, mm: 80 });
      expect(pickPair([other, sea, l], {}, link("r_link"))).toEqual({ a: "r_link", b: "r_sea" });
    });
    it("with no partner on its storm, the latest other run fills the other side", () => {
      const lc = run("r_lc", { iv: true, mm: 80 }), lb = run("r_lb", { mm: 80 });
      expect(pickPair([sea, base, lc], {}, link("r_lc"))).toEqual({ a: "r_sea", b: "r_lc" });
      expect(pickPair([sea, base, lb], {}, link("r_lb"))).toEqual({ a: "r_lb", b: "r_sea" });
    });
    it("alone, it has its slot and the other side waits", () => {
      expect(pickPair([run("r_link", { iv: true })], {}, link("r_link"))).toEqual({ a: undefined, b: "r_link" });
    });
    it("from another area it is not offered, so the default holds", () => {
      expect(pickPair([sea, base], {}, link("r_elsewhere"))).toEqual({ a: "r_base", b: "r_sea" });
    });
  });

  describe("one side already chosen", () => {
    const l = run("r_link", { iv: true });
    it("a chosen A stays and B is filled (the linked run does not take a slot)", () => {
      expect(pickPair([sea, base, l], { a: "r_base" }, link("r_link"))).toEqual({ a: "r_base", b: "r_sea" });
    });
    it("a chosen B stays and A is filled with its baseline", () => {
      expect(pickPair([sea, base, l], { b: "r_link" })).toEqual({ a: "r_base", b: "r_link" });
    });
    it("a chosen side no longer on offer counts as not chosen", () => {
      expect(pickPair([sea, base], { a: "r_gone", b: "r_sea" })).toEqual({ a: "r_base", b: "r_sea" });
    });
  });
});
