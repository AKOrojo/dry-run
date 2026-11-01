// Observation pins (board 12): the agreement test, the pin and card wording, the upload checks and the shared list and add-flow state.
// Pure logic first; the stores at the bottom are plain subscribe/get so both the map and the Sidebar read one list.
import { useEffect, useSyncExternalStore } from "react";
import type { Observation } from "../contracts/gen/Observation";
import { getObservations } from "./api";

const SOURCE_WORDS: Record<Observation["source"], string> = {
  citizen_photo: "a resident's photo",
  drone_video: "a drone video",
  satellite_chip: "a satellite image",
};

/** Plain words for where an observation came from. */
export const sourceWords = (o: Pick<Observation, "source">) => SOURCE_WORDS[o.source] ?? "an uploaded observation";

/** True when the model agrees with the photo: inside the photo's range, or within max(0.1 m, 35 %) of its estimate when there is no range. Null when either side is unknown. */
export function agrees(o: Pick<Observation, "est_depth_m" | "depth_low_m" | "depth_high_m" | "sim_depth_m">): boolean | null {
  const sim = o.sim_depth_m;
  if (sim == null) return null;
  const { depth_low_m: lo, depth_high_m: hi, est_depth_m: est } = o;
  if (lo != null && hi != null) return sim >= lo && sim <= hi;
  if (est == null) return null;
  return Math.abs(sim - est) <= Math.max(0.1, 0.35 * est);
}

/** The ring colour: verified green when they agree, danfo when they do not, muted while the model has no value here. */
export const ringColour = (agree: boolean | null) => (agree == null ? "var(--ink-muted)" : agree ? "var(--verified)" : "var(--danfo)");

const m = (x: number) => `${x.toFixed(2)} m`;

/** The pin label: "0.40 m · model 0.52", without the model part when the run has no value here. */
export function pinLabel(o: Pick<Observation, "est_depth_m" | "sim_depth_m">): string {
  const est = o.est_depth_m != null ? m(o.est_depth_m) : "No depth read";
  return o.sim_depth_m != null ? `${est} · model ${o.sim_depth_m.toFixed(2)}` : est;
}

/** The card heading: "Water outline from a resident's photo", with " · T+hh:mm" when the time is known (time is formatted by the caller). */
export function cardHeading(o: Pick<Observation, "source">, time?: string | null): string {
  return `Water outline from ${sourceWords(o)}${time ? ` · ${time}` : ""}`;
}

/** "0.40 m (0.30–0.60)", or just the estimate when there is no range; null when the photo gave no depth. */
export function waterInPhoto(o: Pick<Observation, "est_depth_m" | "depth_low_m" | "depth_high_m">): string | null {
  if (o.est_depth_m == null) return null;
  return o.depth_low_m != null && o.depth_high_m != null ? `${m(o.est_depth_m)} (${o.depth_low_m.toFixed(2)}–${o.depth_high_m.toFixed(2)})` : m(o.est_depth_m);
}

/** The Layers row note: "3 in this area", or the empty note. */
export const countNote = (n: number) => (n === 0 ? "None yet" : `${n} in this area`);

/** Where the photo's depth is read from, said on every card. */
export const PROVENANCE = "Depth estimated from the photo by SAM 3.1 and Muse Spark. The photo stays private; this is the water it found.";

// ---------------------------------------------------------------- upload checks and copy

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

/** A problem shown as a hazard row: a title, then the next step. `key` marks the judge-key case, shown with the lockout note. */
export type UploadProblem = { title: string; next: string; key?: boolean };

/** Client-side check before sending: the type, then the 8 MB limit. */
export function checkPhoto(f: { type: string; size: number }): UploadProblem | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(f.type)) return { title: "That file isn't a JPEG, PNG or WebP photo.", next: "Choose a JPEG, PNG or WebP photo." };
  if (f.size > PHOTO_MAX_BYTES) return { title: "That photo is over 8 MB.", next: "Choose a smaller one, or a screenshot of it." };
  return null;
}

/** "2.4 MB", one decimal; a file under a tenth of a megabyte says so instead of "0.0 MB". */
export const sizeMB = (bytes: number) => (bytes < 0.05 * 1024 * 1024 ? "under 0.1 MB" : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

/** HH:MM in local time, the given number of seconds after `now`. */
export function retryAtText(retryAfterS: number | undefined, now: Date = new Date()): string {
  const at = new Date(now.getTime() + (retryAfterS ?? 0) * 1000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** The copy for a failed upload, from the HTTP status the server gave. */
export function uploadProblem(status: number, retryAfterS?: number, now: Date = new Date()): UploadProblem {
  switch (status) {
    case 400: return { title: "No water found in this photo.", next: "Try one that shows the water against something of known height: a kerb, a car wheel, a door step." };
    case 413: return { title: "That photo is over 8 MB.", next: "Choose a smaller one, or a screenshot of it." };
    case 415: return { title: "That file isn't a JPEG, PNG or WebP photo.", next: "Choose a JPEG, PNG or WebP photo." };
    case 429: return { title: "Twenty photos this hour already.", next: `Try again at ${retryAtText(retryAfterS, now)}` };
    case 502: return { title: "The image model is not answering.", next: "Nothing was saved. Try again in a minute." };
    case 401:
    case 403: return { title: "Adding observations needs the judge key. Paste it in the Agent tab, then come back.", next: "", key: true };
    default: return { title: "The photo could not be read.", next: "Nothing was saved. Try again in a minute." };
  }
}

// ---------------------------------------------------------------- shared stores

/** Observation lists per area and run ("aoi|run"); null until the first load for that key. */
const lists = new Map<string, Observation[]>();
const listSubs = new Set<() => void>();
const emitList = () => listSubs.forEach((f) => f());
const keyOf = (aoiId: string, runId?: string) => `${aoiId}|${runId ?? ""}`;
const inflight = new Map<string, Promise<Observation[]>>();

/** Add a newly uploaded observation to its list, without refetching. */
export function addObservation(aoiId: string, runId: string | undefined, o: Observation) {
  const k = keyOf(aoiId, runId);
  lists.set(k, [o, ...(lists.get(k) ?? [])]);
  emitList();
}

/** The area's observations (newest first) for a run, or null while they load or when the request failed. Each key change fetches again; a superseded request is aborted. */
export function useObservations(aoiId?: string, runId?: string): Observation[] | null {
  const key = aoiId ? keyOf(aoiId, runId) : "";
  const list = useSyncExternalStore(
    (f) => { listSubs.add(f); return () => { listSubs.delete(f); }; },
    () => (key ? lists.get(key) ?? null : null),
  );
  useEffect(() => {
    if (!aoiId) return;
    // The map and the Layers row both ask: one request per key, shared while it is in flight.
    let alive = true;
    let p = inflight.get(key);
    if (!p) {
      p = getObservations(aoiId, runId).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    p.then((l) => { if (alive) { lists.set(key, l); emitList(); } }).catch(() => { /* offline: no pins */ });
    return () => { alive = false; };
  }, [key]);  // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}

/** The add-a-photo flow and the open pin: which spot the Inspect card is for, a request to take the map centre, and the pin whose card is open. */
type ObsUi = { spot: { lon: number; lat: number; seq: number } | null; centreRequest: number; open: string | null };
let ui: ObsUi = { spot: null, centreRequest: 0, open: null };
let seq = 0;
const uiSubs = new Set<() => void>();
const setUi = (p: Partial<ObsUi>) => { ui = { ...ui, ...p }; uiSubs.forEach((f) => f()); };
export const obsUi = { get: () => ui, subscribe: (f: () => void) => { uiSubs.add(f); return () => { uiSubs.delete(f); }; } };
export const useObsUi = () => useSyncExternalStore(obsUi.subscribe, obsUi.get);

/** Start the Inspect card for a spot (the map's menu). */
export const startAddObservation = (lon: number, lat: number) => setUi({ spot: { lon, lat, seq: ++seq }, open: null });
/** Start it at the map centre (the Layers row): the map resolves the centre. */
export const requestAddAtCentre = () => setUi({ centreRequest: ui.centreRequest + 1, open: null });
export const endAddObservation = () => setUi({ spot: null });
export const openObservation = (id: string | null) => setUi({ open: id });
