import { describe, expect, it } from "vitest";
import { parseInRange, stepValue } from "./NumberField";

describe("number field validation", () => {
  it("rejects out-of-range, empty and junk text", () => {
    for (const text of ["0", "501", "", "12mm", "Infinity"]) expect(parseInRange(text, 1, 500).error).toBe(true);
  });
  it("accepts decimals and bounds", () => {
    expect(parseInRange(" 1.25 ", 1, 500)).toEqual({ value: 1.25, error: false });
    expect(parseInRange("500", 1, 500).value).toBe(500);
  });
  it("steps without floating point drift", () => {
    expect(stepValue("ArrowUp", false, 0.2, 0, 1, 0.1)).toBe(0.3);
    expect(stepValue("ArrowDown", false, 0.3, 0, 1, 0.1)).toBe(0.2);
  });
  it("handles large steps, bounds and optional endpoints", () => {
    expect(stepValue("ArrowUp", true, 1, 0, 5, 0.1)).toBe(2);
    expect(stepValue("PageDown", false, 1, 0, 5, 0.1)).toBe(0);
    expect(stepValue("PageUp", true, 4, 0, 5, 1)).toBe(5);
    expect(stepValue("Home", false, 4, 0, 5)).toBe(0);
    expect(stepValue("End", false, 4, 0, 5)).toBe(5);
    expect(stepValue("Home", false, 4)).toBe(4);
  });
});
