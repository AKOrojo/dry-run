// Street picture (board 12): a before/after picture of one street spot in runs A and B, drawn by Muse Image at the depth
// each run found there (POST /api/render). Pure helpers (unit-tested in streetpic.test.ts) and the large-view store.
import { useSyncExternalStore } from "react";
import { retryAtText } from "./observations";
import type { RunManifest } from "./api";

import type { RenderImage, RenderResult } from "../contracts/gen/RenderResult";

export type { RenderImage, RenderResult };
export type RenderView = NonNullable<RenderResult["request"]["view"]>;

/** The server's MIN_WATER_M (dryrun/meta/render.py): below this peak depth in both runs there is no water to draw. */
export const MIN_WATER_M = 0.05;
export const isDryInBoth = (maxA: number | null | undefined, maxB: number | null | undefined) =>
  maxA != null && maxB != null && maxA < MIN_WATER_M && maxB < MIN_WATER_M;

/** A render usually takes 50–90 s (two image calls and a vision check); after that the card says it is taking longer. */
export const USUAL_MAX_S = 90;
/** The right-hand line under the bar while making: there is no progress stream, so no estimate, only the usual range. */
export const makingNote = (secs: number) => (secs > USUAL_MAX_S ? "taking longer than usual" : "usually 50–90 s");
export const clockText = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

export const metres = (v: number) => `${v.toFixed(2)} m`;
export const aboutMetres = (v: number | null) => (v == null ? "not checked" : `about ${v.toFixed(2)} m`);

/** The mismatch note under the depth table: the first picture whose water is off the model's depth, or null. */
export function mismatchNote(r: Pick<RenderResult, "before" | "after">): { which: "before" | "after"; shows: number; model: number } | null {
  for (const which of ["before", "after"] as const) {
    const im = r[which];
    if (im.picture_matches === false && im.picture_depth_m != null) return { which, shows: im.picture_depth_m, model: im.depth_m };
  }
  return null;
}

/** "AI illustration…" line under the pictures: what the picture is drawn from. */
const LABEL = "AI illustration, not a measurement";  // RENDER_LABEL, when an older result has none
export const sourceNote = (r: Pick<RenderResult, "label" | "source_photo">) =>
  r.source_photo === "uploaded" ? `${r.label ?? LABEL}. Your photo, with the water drawn in at each run's depth.`
    : `${r.label ?? LABEL}. A typical street here, generated: not a photo of this spot.`;

/** The image URL from the server's relative /api/render/... path. */
export const imageUrl = (api: string, url: string) => (/^https?:/.test(url) ? url : `${api.replace(/\/$/, "")}${url}`);

export const RENDER_ID = /^v_[0-9a-f]{16}$/;
/** A link that opens the pair in the large view: the current page with only ?aoi= and ?render=. */
export function renderLink(href: string, aoiId: string, renderId: string): string {
  const u = new URL(href);
  u.search = "";
  u.hash = "";
  u.searchParams.set("aoi", aoiId);
  u.searchParams.set("render", renderId);
  return u.toString();
}

/** "Try again in 14 min." (or at the clock time when it is over an hour away). */
export const retryIn = (retryAfterS: number | undefined, now: Date = new Date()) =>
  !retryAfterS ? "Try again later." : retryAfterS > 3600 ? `Try again at ${retryAtText(retryAfterS, now)}.` : `Try again in ${Math.max(1, Math.ceil(retryAfterS / 60))} min.`;

export type StreetProblem = { title: string; detail: string; action: "spot" | "key" | "ok" };
/** The copy for a failed POST /api/render, from the HTTP status and the server's message. */
export function renderProblem(status: number, message: string, retryAfterS?: number, now: Date = new Date(), lockout = false): StreetProblem {
  if (lockout || status === 401 || status === 403) return { title: "The judge key is needed for a new pair", detail: "Pictures already made open without it.", action: "key" };
  if (status === 422 && /content filter/i.test(message)) return { title: "The image model declined this picture", detail: "Its content filter refused this street. Pick a spot a little further along.", action: "spot" };
  if (status === 400 && /no water/i.test(message)) return DRY;
  switch (status) {
    case 429: return { title: "Too many new pictures this hour", detail: `${retryIn(retryAfterS, now)} Pictures already made still open.`, action: "ok" };
    case 409: return { title: "This pair is being made right now", detail: "Someone asked for the same pictures a moment ago. Try again in a minute; it then opens at once.", action: "ok" };
    case 413: return { title: "That photo is over 8 MB", detail: "Choose a smaller one, or a screenshot of it.", action: "ok" };
    case 415: return { title: "That file isn't a JPEG, PNG or WebP photo", detail: "Choose a JPEG, PNG or WebP photo.", action: "ok" };
    case 503: return { title: "Street pictures are not set up on this server", detail: "The image model is not configured here.", action: "ok" };
    case 502: return { title: "The image model is not answering", detail: /people/i.test(message) ? message : "Try again in a minute.", action: "ok" };
    case 400: return { title: "These pictures could not be made", detail: message || "Try another spot.", action: "spot" };
    default: return { title: "These pictures could not be made", detail: "Try again in a minute.", action: "ok" };
  }
}
export const DRY: StreetProblem = { title: "Dry here in both runs", detail: "There is no water to draw at this spot. Pick a spot that floods in A or B.", action: "spot" };

// ---------------------------------------------------------------- large view
/** The phone's large view: the picture at its own aspect ratio, as large as the room allows (by width, or by height when
 *  that is the tighter side), never cropped. */
export function fitBox(roomW: number, roomH: number, aspect: number): { w: number; h: number } {
  if (!(roomW > 0) || !(roomH > 0) || !(aspect > 0)) return { w: Math.max(0, roomW), h: Math.max(0, roomW) / (aspect > 0 ? aspect : 16 / 9) };
  const w = Math.min(roomW, roomH * aspect);
  return { w: Math.floor(w), h: Math.floor(w / aspect) };
}
/** The phone legend under the picture: each side's run and model depth, in full ("A · Baseline · model 0.13 m"). */
export const legendLine = (letter: "A" | "B", what: string | undefined, depthM: number | null | undefined) =>
  `${letter}${what ? ` · ${what}` : ""}${depthM != null ? ` · model ${metres(depthM)}` : ""}`;
export type LargeView = { r: RenderResult; a?: RunManifest; b?: RunManifest; /** focused when it opened: focus goes back there on close */ from: Element | null };
let large: LargeView | null = null;
const subs = new Set<() => void>();
/** Open the large view (a and b: the runs, when known; a link loads them). */
export const openLarge = (r: RenderResult | null, runs: { a?: RunManifest; b?: RunManifest } = {}) => { large = r ? { r, ...runs, from: typeof document === "undefined" ? null : document.activeElement } : null; subs.forEach((f) => f()); };
export const useLarge = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => large);
