// Run labels for Compare (B's design, Nov 1): what a run is, its storm, then only the settings that differ from the
// default, so two runs on offer never read the same. Pure: Compare, the map chips, the charts and the street picture
// all take their labels from here.
import type { RunManifest } from "./api";
import { drainageDiff } from "./drainage";
import type { DrainageDefault } from "./drainage";

/** The time pattern in the TopBar's short words. */
export const PATTERN_TEXT = { uniform: "uniform", front_loaded: "front-loaded", center_peaked: "centre-peaked" } as const;

export const describeIv = (iv: { type: string; [k: string]: unknown }) =>
  iv.type === "tide" ? `Sea level ${(iv.boundary_level_m as number) > 0 ? "+" : ""}${iv.boundary_level_m} m`
  : iv.type === "drain_upgrade" ? `Drains ×${iv.capacity_factor ?? "?"}`
  : iv.type === "green" ? "Green infrastructure" : iv.type === "pond" ? "Retention pond" : iv.type === "road_closure" ? "Road closure" : iv.type;

/** "Baseline" or the run's interventions (a raised sea level is one of them). */
export const runWhat = (m: RunManifest) => (m.scenario.interventions?.length ? m.scenario.interventions.map(describeIv).join(", ") : "Baseline");

/** Where the rain fell, when it was not the whole area: the place's name, else the kind of rain area. */
export function rainArea(m: RunManifest): string | null {
  const sp = m.scenario.storm.spatial;
  if (!sp) return null;
  if (sp.place) return sp.place;
  return sp.kind === "polygon" ? "drawn area" : sp.track ? "moving cell" : "storm cell";
}

/** The settings that differ from the default, in order: time pattern, rain area, drainage. A raised sea level is
 *  already in runWhat (the tide intervention), so it is not repeated here. */
export function runExtras(m: RunManifest, def?: DrainageDefault | null): string[] {
  const out: string[] = [];
  const p = m.scenario.storm.pattern ?? "uniform";
  if (p !== "uniform") out.push(PATTERN_TEXT[p]);
  const area = rainArea(m);
  if (area) out.push(area);
  const d = drainageDiff(m.scenario.drainage, def);
  if (d) out.push(d);
  return out;
}

/** "<what> · <total> mm / <h> h", then the settings that differ from the default. */
export const runLabel = (m: RunManifest, def?: DrainageDefault | null) =>
  [`${runWhat(m)} · ${m.scenario.storm.total_mm} mm / ${m.scenario.storm.duration_h} h`, ...runExtras(m, def)].join(" · ");

/** The shortest run-id prefixes that tell these runs apart, at least 4 characters after "r_". */
export function shortIds(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const body = (id: string) => (id.startsWith("r_") ? id.slice(2) : id);
  for (const id of ids) {
    const b = body(id);
    let n = Math.min(4, b.length);
    while (n < b.length && ids.some((o) => o !== id && body(o).startsWith(b.slice(0, n)))) n++;
    out.set(id, `${id.startsWith("r_") ? "r_" : ""}${b.slice(0, n)}`);
  }
  return out;
}

/** Labels for the runs on offer: runs whose labels still match get their short run id at the end. */
export function runLabels(runs: RunManifest[], def?: DrainageDefault | null): Map<string, string> {
  const base = new Map(runs.map((m) => [m.run_id, runLabel(m, def)] as const));
  const groups = new Map<string, string[]>();
  base.forEach((label, id) => groups.set(label, [...(groups.get(label) ?? []), id]));
  const out = new Map(base);
  groups.forEach((ids, label) => {
    if (ids.length < 2) return;
    shortIds(ids).forEach((s, id) => out.set(id, `${label} · ${s}`));
  });
  return out;
}
