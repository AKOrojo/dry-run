import { describe, expect, it } from "vitest";
import { isRunId, resolveLink } from "./link";
import type { LinkDeps } from "./link";
import type { AOIManifest, RunManifest } from "./api";

const aoi = (id: string) => ({ aoi_id: id, name: id }) as unknown as AOIManifest;
const run = (id: string, aoiId: string, endS = 3600) =>
  ({ run_id: id, status: "done", scenario: { aoi_id: aoiId }, frames: [{ t_s: 0 }, { t_s: endS }] }) as unknown as RunManifest;

const RUN_Q = "r_51c3ddfba208d51e", RUN_V0 = "r_461a399ac555390d";
const AOIS = ["lagos-lekki-v3", "nyc-queens-v1", "nyc-queens-v0"];
const RUNS: Record<string, RunManifest> = { [RUN_Q]: run(RUN_Q, "nyc-queens-v1"), [RUN_V0]: run(RUN_V0, "nyc-queens-v0") };

function deps(over: Partial<LinkDeps> = {}): LinkDeps & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    defaultAoi: "lagos-lekki-v3",
    successors: { "nyc-queens-v0": "nyc-queens-v1", "lagos-lekki-v2": "lagos-lekki-v3" },
    picked: () => false,
    getRun: async (id) => { fetched.push(id); if (!RUNS[id]) throw new Error("404"); return RUNS[id]; },
    getAOI: async (id) => { if (!AOIS.includes(id)) throw new Error("404"); return aoi(id); },
    ...over,
  };
}

describe("isRunId", () => {
  it("accepts r_ and 16 hex", () => expect(isRunId(RUN_Q)).toBe(true));
  it.each(["../../api/config", "r_000000000000", "", "r_51C3DDFBA208D51E", `${RUN_Q}x`, "r_51c3ddfba208d51e/../x"])("rejects %j", (s) => expect(isRunId(s)).toBe(false));
});

describe("resolveLink", () => {
  it("never fetches a run id that is not one, and says the run was not found", async () => {
    const d = deps();
    const r = await resolveLink({ run: "../../api/config" }, d);
    expect(d.fetched).toEqual([]);
    expect(r?.note).toBe("The shared run was not found");
    expect(r?.query).toEqual({ aoi: undefined, run: undefined, t: undefined });
  });

  it("a pick beats a late answer: null, nothing to apply", async () => {
    let pickedNow = false;
    const d = deps({ getRun: async (id) => { pickedNow = true; throw new Error(`404 ${id}`); }, picked: () => pickedNow });
    expect(await resolveLink({ run: "r_0000000000000000" }, d)).toBeNull();
  });

  it("a pick while the area loads also wins", async () => {
    let pickedNow = false;
    const d = deps({ getAOI: async (id) => { pickedNow = true; return aoi(id); }, picked: () => pickedNow });
    expect(await resolveLink({ aoi: "nyc-queens-v1" }, d)).toBeNull();
  });

  it("a run opens on its own area and the address bar names that area", async () => {
    const r = await resolveLink({ aoi: "lagos-lekki-v3", run: RUN_Q, t: 600 }, deps());
    expect(r?.aoi.aoi_id).toBe("nyc-queens-v1");
    expect(r?.query).toEqual({ aoi: "nyc-queens-v1", run: RUN_Q, t: 600 });
  });

  it("an older-version run keeps its own grid (v0), not the successor", async () => {
    const r = await resolveLink({ aoi: "nyc-queens-v1", run: RUN_V0 }, deps());
    expect(r?.aoi.aoi_id).toBe("nyc-queens-v0");
    expect(r?.query.aoi).toBe("nyc-queens-v0");
  });

  it("an old area id with no run opens its successor", async () => {
    const r = await resolveLink({ aoi: "lagos-lekki-v2" }, deps());
    expect(r?.aoi.aoi_id).toBe("lagos-lekki-v3");
    expect(r?.note).toBeUndefined();
    expect(r?.query.aoi).toBe("lagos-lekki-v3");
  });

  it("a link to the default area keeps naming it", async () => {
    expect((await resolveLink({ aoi: "lagos-lekki-v3" }, deps()))?.query.aoi).toBe("lagos-lekki-v3");
    expect((await resolveLink({}, deps()))?.query.aoi).toBeUndefined();
  });

  it("an unknown area falls back to the default and says so", async () => {
    const r = await resolveLink({ aoi: "nope" }, deps());
    expect(r?.aoi.aoi_id).toBe("lagos-lekki-v3");
    expect(r?.note).toBe("The shared area is not available");
    expect(r?.query.aoi).toBeUndefined();
  });

  it("clamps t to the run, and leaves no t when none was given", async () => {
    expect((await resolveLink({ run: RUN_Q, t: 999999 }, deps()))?.query.t).toBe(3600);
    expect((await resolveLink({ run: RUN_Q }, deps()))?.query.t).toBeUndefined();
  });
});
