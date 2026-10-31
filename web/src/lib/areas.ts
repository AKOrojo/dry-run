// What the area picker says about each area (its second line), from the area's own manifest and the server's cache.
import { estimateSim, getAOI, getPresets } from "./api";
import type { ScenarioSpec } from "./api";

/** An area's baseline preset: whole-area rain, no interventions (warmed on the server, so its run is cached). */
export const isBase = (p: ScenarioSpec) => !p.interventions?.length && !p.storm.spatial && p.storm.total_mm > 0;

/** The baseline preset's run id when that run is already cached, else null. */
export async function cachedBaseRun(aoiId: string): Promise<string | null> {
  const base = (await getPresets(aoiId))?.find(isBase);
  const est = base && await estimateSim(base).catch(() => null);
  return est?.cached ? est.run_id : null;
}

const SYSTEM: Record<string, string> = { open: "Open drains", closed: "Closed sewers", mixed: "Mixed drains" };
export type AreaFacts = { system: string | null; inflows: boolean; cached: boolean };

const facts = new Map<string, Promise<AreaFacts>>();
/** Fetched once per area per page load. */
export function areaFacts(aoiId: string): Promise<AreaFacts> {
  let p = facts.get(aoiId);
  if (!p) {
    p = Promise.all([getAOI(aoiId).catch(() => null), cachedBaseRun(aoiId).catch(() => null)]).then(([m, run]) => ({
      system: m?.drainage_default ? SYSTEM[m.drainage_default.system] ?? null : null,
      inflows: !!m?.layers?.inflows, cached: !!run,
    }));
    p.catch(() => facts.delete(aoiId));
    facts.set(aoiId, p);
  }
  return p;
}

/** "Closed sewers · hero run cached" (board 11). */
export const areaDetail = (f: AreaFacts | undefined, isDefault: boolean) =>
  [f?.system, f?.inflows ? "River inflows" : null, isDefault ? "default area" : null, f?.cached ? "hero run cached" : null].filter(Boolean).join(" · ") || undefined;
