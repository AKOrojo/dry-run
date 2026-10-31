// Opening a shared link (?aoi=&run=&t=): which area and run to show, what to tell the user, and the address bar to
// leave behind. Pure apart from the two fetches passed in, so the rules are unit-tested (link.test.ts).
import type { AOIManifest, RunManifest } from "./api";
import type { SharedView } from "./view";

/** Run ids are content hashes: r_ and 16 hex. Anything else (e.g. "../../api/config") is a dead link, never fetched. */
export const isRunId = (s: string) => /^r_[0-9a-f]{16}$/.test(s);

export type LinkDeps = {
  getRun: (id: string) => Promise<RunManifest>;
  getAOI: (id: string) => Promise<AOIManifest>;
  defaultAoi: string;
  successors?: Record<string, string>;
  /** True once the user has picked an area: the link's late answer is then dropped. */
  picked: () => boolean;
};

export type LinkResult = {
  aoi: AOIManifest;
  /** The run to open (done, on this area), and the clock time clamped to it. */
  run?: RunManifest; t?: number;
  note?: string;
  /** The query to leave in the address bar: only what is actually shown. */
  query: { aoi?: string; run?: string; t?: number };
};

/** null when the user picked an area while the link was loading. */
export async function resolveLink(shared: SharedView, d: LinkDeps): Promise<LinkResult | null> {
  const m = shared.run && isRunId(shared.run) ? await d.getRun(shared.run).catch(() => undefined) : undefined;
  if (d.picked()) return null;
  // An old area id with no run opens its successor (a new version of the same area); a run keeps the area it ran on.
  const linked = shared.aoi && !m ? (d.successors?.[shared.aoi] ?? shared.aoi) : shared.aoi;
  const want = m?.scenario.aoi_id ?? linked ?? d.defaultAoi;
  const aoi = await d.getAOI(want).catch(() => d.getAOI(d.defaultAoi));
  if (d.picked()) return null;
  const runGone = !!shared.run && !m, aoiGone = !runGone && !!shared.aoi && aoi.aoi_id !== want;
  const note = runGone ? "The shared run was not found" : aoiGone ? "The shared area is not available" : undefined;
  const run = m?.status === "done" && m.scenario.aoi_id === aoi.aoi_id ? m : undefined;
  const maxS = run?.frames.at(-1)?.t_s ?? 0;
  const t = run ? Math.min(Math.max(shared.t ?? 0, 0), maxS) : undefined;
  return {
    aoi, run, t, note,
    // A link that named an area keeps naming it (the default area has changed before: v2 -> v3).
    query: { aoi: (shared.aoi && !aoiGone) || run || aoi.aoi_id !== d.defaultAoi ? aoi.aoi_id : undefined, run: run?.run_id, t: run && shared.t != null ? Math.round(t!) : undefined },
  };
}
