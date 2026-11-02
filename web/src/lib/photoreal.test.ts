import { describe, expect, it } from "vitest";
import { classify, downText, errorLine, ionRefused, isDown, LIMIT_WAIT_MS, mayLoadPhotoreal } from "./photoreal";

const now = 1_000_000;

describe("photoreal failure", () => {
  it("treats a 429 as Google's daily limit, offered again after Retry-After or 10 min", () => {
    expect(classify({ statusCode: 429 }, now)).toEqual({ kind: "limit", status: 429, retryAt: now + LIMIT_WAIT_MS });
    expect(classify({ statusCode: 429, responseHeaders: { "retry-after": "120" } }, now).retryAt).toBe(now + 120_000);
    expect(downText("limit")).toMatch(/daily limit is reached\. Showing the aerial map\.$/);
  });
  it("treats 401 and 403 as a refused key, never offered again", () => {
    for (const s of [401, 403]) expect(classify({ statusCode: s }, now)).toMatchObject({ kind: "key", retryAt: Infinity });
    expect(downText("key")).toMatch(/refused the key/);
  });
  it("treats any refusal by Cesium ion itself as unavailable, never offered again", () => {
    for (const s of [401, 403, 404, 429, 500, 503]) expect(classify(ionRefused({ statusCode: s }), now)).toEqual({ kind: "unavailable", status: s, retryAt: Infinity });
    expect(classify(ionRefused(new Error("Failed to fetch")), now)).toEqual({ kind: "unavailable", status: null, retryAt: Infinity });
    expect(downText("unavailable")).toBe("Google's 3D city isn't available right now. Showing the aerial map.");
    expect(downText("unavailable", true)).toBe("Google's 3D city isn't available right now. Showing the street map.");
    expect(errorLine(ionRefused({ statusCode: 403 }))).toMatch(/^Cesium ion refused the Google Photorealistic 3D Tiles asset: HTTP 403/);
  });
  it("offers anything else again at once", () => {
    expect(classify({ statusCode: 500 }, now)).toEqual({ kind: "other", status: 500, retryAt: now });
    expect(classify(new Error("network"), now)).toMatchObject({ kind: "other", status: null });
    expect(downText("other")).toBe("Google's 3D city couldn't load. Showing the aerial map.");
  });
  it("stays down until the retry time", () => {
    const d = classify({ statusCode: 429 }, now);
    expect(isDown(d, now + 1)).toBe(true);
    expect(isDown(d, d.retryAt)).toBe(false);
    expect(isDown(classify({ statusCode: 500 }, now), now)).toBe(false);
    expect(isDown(null)).toBe(false);
  });
  it("never loads again after any failure until Try 3D again clears it (area switches included)", () => {
    for (const s of [500, 429, 403]) expect(mayLoadPhotoreal(classify({ statusCode: s }, now))).toBe(false);
    expect(mayLoadPhotoreal(null)).toBe(true);
  });
  it("logs the status and Google's message, not a minified class name", () => {
    const line = errorLine({ statusCode: 429, response: '{"error": {"code": 429, "message": "Quota exceeded for quota metric \'3D Tiles root requests\'"}}' });
    expect(line).toMatch(/HTTP 429: \{"error": \{"code": 429, "message": "Quota exceeded/);
    expect(errorLine({})).toMatch(/HTTP no status$/);
  });
});
