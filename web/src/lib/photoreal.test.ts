import { describe, expect, it } from "vitest";
import { classify, downText, errorLine, isDown, LIMIT_WAIT_MS } from "./photoreal";

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
  it("logs the status and Google's message, not a minified class name", () => {
    const line = errorLine({ statusCode: 429, response: '{"error": {"code": 429, "message": "Quota exceeded for quota metric \'3D Tiles root requests\'"}}' });
    expect(line).toMatch(/HTTP 429: \{"error": \{"code": 429, "message": "Quota exceeded/);
    expect(errorLine({})).toMatch(/HTTP no status$/);
  });
});
