// Drainage (design board 10, contract 0.8.0, Eng A): the Scenario tab's Drainage card state, the drains layer and the
// per-frame drain fill. Untouched, the scenario carries no `drainage` block (the area's default, so warmed presets stay
// instant); any change sends the whole block.
import { useSyncExternalStore } from "react";
import { API, runFileUrl } from "./api";
import { fmtT } from "../components/ds";
import type { RunManifest } from "./api";
import type { DrainageDefault } from "../contracts/gen/AOIManifest";
import type { Drainage } from "../contracts/gen/ScenarioSpec";
import type { DrainFill } from "../contracts/gen/DrainFill";
import { areaCache } from "./areaCache";

export type { DrainageDefault, Drainage, DrainFill };
export type DrainSystem = "closed" | "open" | "mixed";
export type Outfall = "tide" | "free" | "blocked";

export const SYSTEM_LABEL: Record<DrainSystem, string> = { closed: "Closed sewer", open: "Open drains", mixed: "Mixed" };
export const SYSTEM_SHORT: Record<DrainSystem, string> = { closed: "Closed", open: "Open", mixed: "Mixed" };
export const SYSTEM_EXPLAIN: Record<DrainSystem, string> = {
  closed: "Street inlets (catch basins) into pipes. When the pipes are full, water stops going in and comes back up at the lowest inlets.",
  open: "Open gutters along the roads, with covered slab sections. They carry water to the lagoon and spill onto the road when full or blocked.",
  mixed: "Open gutters plus sewers fed by street inlets. Water fills both before it comes back onto the road.",
};

/** What the card shows: every field resolved (the area default until the user changes something). */
export type DrainCard = {
  system: DrainSystem;
  /** A design return period from the area's table, or null for a typed rain intensity. */
  returnPeriod: number | null; capacityMmH: number;
  blockagePct: number; outfall: Outfall; flapGates: boolean; roadsideGutters: boolean;
};
type State = {
  aoiId: string | null; def: DrainageDefault | null; card: DrainCard | null; touched: boolean;
  /** A loaded run's block, sent back verbatim until the user edits: the same spec, so the same run_id (cached). */
  sent: Drainage | null;
};

let state: State = { aoiId: null, def: null, card: null, touched: false, sent: null };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
export const drainageStore = { get: () => state, subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; } };
export const useDrainage = () => useSyncExternalStore(drainageStore.subscribe, drainageStore.get);

/** Return periods the area publishes a design rate for, ascending. Lagos has none (no published standard). */
export const returnPeriods = (def: DrainageDefault | null): number[] =>
  Object.keys(def?.design_mm_h_by_return_period ?? {}).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
export const designMmH = (def: DrainageDefault | null, rp: number) => def?.design_mm_h_by_return_period?.[String(rp)] ?? null;

export function cardFromDefault(def: DrainageDefault): DrainCard {
  const rp = def.return_period_yr != null && designMmH(def, def.return_period_yr) != null ? def.return_period_yr : null;
  return {
    system: def.system as DrainSystem, returnPeriod: rp, capacityMmH: rp != null ? designMmH(def, rp)! : def.capacity_mm_h,
    blockagePct: def.blockage_pct, outfall: "tide", flapGates: def.flap_gates, roadsideGutters: def.roadside_gutters,
  };
}

/** A new area (or a run loaded into the editor): back to that area's default, untouched. */
export function resetDrainage(aoiId: string | null, def: DrainageDefault | null | undefined) {
  state = { aoiId, def: def ?? null, card: def ? cardFromDefault(def) : null, touched: false, sent: null };
  emit();
}
/** A user change: the scenario now sends the full block. */
export function setDrainage(patch: Partial<DrainCard>) {
  if (!state.card) return;
  state = { ...state, card: { ...state.card, ...patch }, touched: true, sent: null };
  emit();
}
/** A loaded run's own drainage (shared link, agent run): shown in the card, as sent. */
export function adoptDrainage(d: Drainage | null | undefined) {
  if (!state.def) return;
  if (!d) { resetDrainage(state.aoiId, state.def); return; }
  const base = cardFromDefault(state.def);
  // Neither capacity field: the area's design storm, as the server ran it.
  const rp = d.return_period_yr ?? (d.capacity_mm_h == null ? base.returnPeriod : null);
  state = { ...state, touched: true, sent: d, card: {
    system: (d.system as DrainSystem) ?? base.system, returnPeriod: rp,
    capacityMmH: d.capacity_mm_h ?? (rp != null ? designMmH(state.def, rp) ?? base.capacityMmH : base.capacityMmH),
    blockagePct: d.blockage_pct ?? base.blockagePct, outfall: (d.outfall as Outfall) ?? base.outfall,
    flapGates: d.flap_gates ?? base.flapGates, roadsideGutters: d.roadside_gutters ?? base.roadsideGutters,
  } };
  emit();
}

/** The scenario's `drainage` block: undefined while untouched (the area default). Exactly one of return_period_yr and
 *  capacity_mm_h (both is a 422); roadside gutters only where there are open drains. */
export function drainageSpec(s: State = state): Drainage | undefined {
  if (s.sent) return s.sent;
  if (!s.touched || !s.card || !s.def) return undefined;
  const c = s.card;
  return {
    system: c.system,
    ...(c.returnPeriod != null ? { return_period_yr: c.returnPeriod } : { capacity_mm_h: c.capacityMmH }),
    blockage_pct: c.blockagePct, outfall: c.outfall, flap_gates: c.flapGates,
    roadside_gutters: c.system === "closed" ? false : c.roadsideGutters,
  } as Drainage;
}

// ---- fill colours (board 10): under 40 % pale, under 80 % depth-3, under 95 % danfo, then hazard ----
export const FULL_PCT = 95;
export type FillTone = { token: string; alpha: number };
export function fillTone(pct: number | null | undefined): FillTone {
  if (pct == null) return { token: "--ink", alpha: 1 };
  if (pct < 40) return { token: "--depth-3", alpha: 0.35 };
  if (pct < 80) return { token: "--depth-3", alpha: 1 };
  if (pct < FULL_PCT) return { token: "--danfo", alpha: 1 };
  return { token: "--hazard", alpha: 1 };
}

// ---- data ----
export type DrainKind = "open_drain" | "covered_drain" | "gutter_inferred" | "canal" | "sewer_zone" | "inlet" | "outfall";
export type DrainFeature = { type: "Feature"; geometry: { type: string; coordinates: any }; properties: { id: string; kind: DrainKind; name?: string | null; receiving?: string | null; gated?: boolean | null; [k: string]: unknown } };
const memo = areaCache<string, Promise<any>>();
const once = <T,>(key: string, f: () => Promise<T>): Promise<T> => {
  let p = memo.get(key);
  if (!p) { p = f().catch((e) => { memo.delete(key); throw e; }); memo.set(key, p); }
  return p;
};
/** The area's drains layer (one FeatureCollection: lines, zones, inlets, outfalls); null when it has none. */
export const getDrains = (aoiId: string) => once(`drains:${aoiId}`, () => fetch(`${API}/api/aoi/${aoiId}/layer/drains_geojson`)
  .then((r) => (r.ok ? r.json() : null)).then((fc) => (fc?.features ? (fc.features as DrainFeature[]) : null)).catch(() => null));
/** A run's drain fill (per frame, per drain line and sewer zone); null on legacy runs. */
export const getDrainFill = (runsBase: string, run: RunManifest) => !run.drain_fill ? Promise.resolve(null)
  : once(`fill:${run.run_id}`, () => fetch(runFileUrl(runsBase, run.run_id, run.drain_fill!)).then((r) => (r.ok ? r.json() as Promise<DrainFill> : null)).catch(() => null));
/** Fill (0-100) of every id at the frame nearest t. */
export function fillAt(df: DrainFill, t: number): Map<string, number> {
  let fi = 0;
  for (let i = 1; i < df.t_s.length; i++) if (Math.abs(df.t_s[i] - t) < Math.abs(df.t_s[fi] - t)) fi = i;
  const row = df.fill_pct[fi] ?? [];
  return new Map(df.ids.map((id, i) => [id, row[i] ?? 0]));
}
/** The drainage stats of a run, or null on a legacy run (they are all null there). Captured and surcharge are gross
 *  (open drains spill and take the same water in again downstream); drained is net, = outfall + storage gained. */
export function drainStats(run?: RunManifest | null) {
  const s = run?.stats as Record<string, number | null | undefined> | null | undefined;
  if (!s || s.sewer_captured_m3 == null) return null;
  return {
    captured: s.sewer_captured_m3, drained: s.drained_volume_m3 ?? null, surcharge: s.sewer_surcharge_m3 ?? null, outfall: s.drain_outfall_m3 ?? null, storageEnd: s.drain_storage_end_m3 ?? null,
    peakPct: s.drain_peak_full_pct ?? null, fullT: s.drain_full_t_s ?? null, overflowFrom: s.drain_surcharge_start_t_s ?? null, overflowTo: s.drain_surcharge_end_t_s ?? null,
    /** Rain applied to land: what the drains could take in. */ rainM3: (s.rain_volume_m3 as number | null | undefined) ?? null,
  };
}

// The dock's drain chart and timeline note (Dock.tsx), outside Drainage.tsx so they do not pull in its chunk.
type TS = NonNullable<RunManifest["timeseries"]>;
/** The drain series of a run, or null on a legacy run. */
export const drainSeries = (ts?: TS | null) => (ts?.drain_full_pct && ts.drain_full_pct.length > 1 ? ts.drain_full_pct : null);

/** The timeline band's note: "Drains full at T+01:30 · overflowing T+01:50–T+03:40", or undefined. */
export function drainNote(run?: RunManifest | null): string | undefined {
  const s = drainStats(run);
  if (!s) return undefined;
  const parts: string[] = [];
  if (s.fullT != null) parts.push(`Drains full at ${fmtT(s.fullT)}`);
  if (s.overflowFrom != null) parts.push(s.overflowTo != null ? `overflowing ${fmtT(s.overflowFrom)}–${fmtT(s.overflowTo)}` : `overflowing from ${fmtT(s.overflowFrom)}`);
  return parts.length ? parts.join(" · ") : undefined;
}
