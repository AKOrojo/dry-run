import { describe, expect, it } from "vitest";
import { belowFetchDue, belowWhere } from "./flyroute";

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

describe("belowWhere", () => {
  it("is in for points inside the bounds and on the west and north edges", () => {
    expect(belowWhere([3.5, 6.45], B)).toBe("in");
    expect(belowWhere([3.47, 6.51], B)).toBe("in");
    expect(belowWhere([3.6199, 6.4201], B)).toBe("in");
  });
  it("is out on the east and south edges, after the 4-decimal rounding the request uses", () => {
    expect(belowWhere([3.62, 6.45], B)).toBe("out");
    expect(belowWhere([3.5, 6.42], B)).toBe("out");
    expect(belowWhere([3.61996, 6.45], B)).toBe("out");
    expect(belowWhere([3.5, 6.42004], B)).toBe("out");
  });
  it("is out past any edge", () => {
    expect(belowWhere([3.469, 6.45], B)).toBe("out");
    expect(belowWhere([3.621, 6.45], B)).toBe("out");
    expect(belowWhere([3.5, 6.419], B)).toBe("out");
    expect(belowWhere([3.5, 6.511], B)).toBe("out");
  });
  it("is unknown before the bounds load and for the HUD's [0, 0] placeholder", () => {
    expect(belowWhere([3.5, 6.45], undefined)).toBe("unknown");
    expect(belowWhere([0, 0], B)).toBe("unknown");
  });
});
