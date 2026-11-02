// Why Google's Photorealistic 3D Tiles did not load, and when to offer them again. Cesium rejects with a
// RequestErrorEvent (statusCode, response, responseHeaders) whose minified class name says nothing, so the status
// decides: 429 = Google's daily limit (never retried by itself), 401/403 = the key was refused, anything else = try again.
// A refusal from Cesium ion itself (the asset endpoint, wrapped as IonRefused) is "unavailable": ion is not asked again.
export type PhotorealDown = { kind: "limit" | "key" | "unavailable" | "other"; status: number | null; /** ms epoch; Infinity = not offered again */ retryAt: number };

/** Retry wait for a 429 that gives no Retry-After. */
export const LIMIT_WAIT_MS = 10 * 60 * 1000;

type ReqError = { statusCode?: unknown; status?: unknown; response?: unknown; responseHeaders?: Record<string, unknown> };
/** A failure of the request to Cesium ion (api.cesium.com), as opposed to one from Google's tile servers. */
export type IonRefused = { ion: true; cause: unknown };
export const ionRefused = (cause: unknown): IonRefused => ({ ion: true, cause });
const isIon = (err: unknown): err is IonRefused => !!err && typeof err === "object" && (err as { ion?: unknown }).ion === true;

export function classify(err: unknown, now = Date.now()): PhotorealDown {
  const e = ((isIon(err) ? err.cause : err) ?? {}) as ReqError;
  const raw = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : null;
  const status = raw && raw > 0 ? raw : null;
  if (isIon(err)) return { kind: "unavailable", status, retryAt: Infinity };
  if (status === 429) {
    const ra = Number(e.responseHeaders?.["retry-after"] ?? e.responseHeaders?.["Retry-After"]);
    return { kind: "limit", status, retryAt: now + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : LIMIT_WAIT_MS) };
  }
  if (status === 401 || status === 403) return { kind: "key", status, retryAt: Infinity };
  return { kind: "other", status, retryAt: now };
}

/** street: the fallback is the street map (Cesium ion refused the aerial imagery too, lib/layers.ts). */
export function downText(kind: PhotorealDown["kind"], street = false): string {
  const showing = street ? "Showing the street map." : "Showing the aerial map.";
  if (kind === "limit") return `Google's 3D city isn't available right now: its daily limit is reached. ${showing}`;
  if (kind === "key") return `Google's 3D city isn't available: the map service refused the key. ${showing}`;
  if (kind === "unavailable") return `Google's 3D city isn't available right now. ${showing}`;
  return `Google's 3D city couldn't load. ${showing}`;
}

/** One line for the console: the status and the start of the response body (Google's error JSON says which limit). */
export function errorLine(err: unknown): string {
  if (isIon(err)) return `Cesium ion refused the Google Photorealistic 3D Tiles asset: ${errorLine(err.cause).replace(/^Google Photorealistic 3D Tiles \(tile.googleapis.com via Cesium ion\): /, "")}`;
  const e = (err ?? {}) as ReqError & { message?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : "no status";
  const body = typeof e.response === "string" ? e.response : e.response instanceof ArrayBuffer ? new TextDecoder().decode(e.response) : "";
  const msg = typeof e.message === "string" && e.message ? e.message : body.replace(/\s+/g, " ").slice(0, 200);
  return `Google Photorealistic 3D Tiles (tile.googleapis.com via Cesium ion): HTTP ${status}${msg ? `: ${msg}` : ""}`;
}

/** Try 3D again is not offered yet at `now` (a 429 waits for Retry-After or 10 min; a refused key never). */
export const isDown = (d: PhotorealDown | null, now = Date.now()) => !!d && now < d.retryAt;

/** Photoreal is requested only with no failure on record: whatever the cause, nothing asks Google again (area switches
 *  included) until the user presses Try 3D again, which clears it. */
export const mayLoadPhotoreal = (d: PhotorealDown | null) => d === null;
