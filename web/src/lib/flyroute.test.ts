import { describe, expect, it } from "vitest";
import { belowFetchDue } from "./flyroute";

const B = [3.47, 6.42, 3.62, 6.51];

describe("belowFetchDue", () => {
  it("skips the HUD's starting [0, 0] and any point off the area", () => {
    expect(belowFetchDue([0, 0], null, B)).toBe(false);
    expect(belowFetchDue([3.5, 6.3], null, B)).toBe(false);
    expect(belowFetchDue([3.7, 6.45], null, B)).toBe(false);
  });
  it("skips everything until the area's bounds are known", () => {
    expect(belowFetchDue([3.5, 6.45], null, undefined)).toBe(false);
  });
  it("fetches the first point inside the area", () => {
    expect(belowFetchDue([3.5, 6.45], null, B)).toBe(true);
  });
  it("refetches only once the camera is ~60 m from the last fetch", () => {
    expect(belowFetchDue([3.5003, 6.45], [3.5, 6.45], B)).toBe(false);
    expect(belowFetchDue([3.5006, 6.45], [3.5, 6.45], B)).toBe(true);
  });
});
