import { describe, expect, it } from "vitest";
import { nextValue, roundValue } from "./Slider";

describe("Slider keyboard values", () => {
  it.each([["ArrowLeft", -0.1], ["ArrowDown", -0.1], ["ArrowRight", 0.1], ["ArrowUp", 0.1], ["PageUp", 1], ["PageDown", -1], ["Home", -2], ["End", 2]])("handles %s", (key, result) => {
    expect(nextValue(key as string, false, 0, -2, 2, 0.1)).toBe(result);
  });
  it("accelerates shifted arrows and clamps", () => {
    expect(nextValue("ArrowUp", true, 0, -2, 2, 0.1)).toBe(1);
    expect(nextValue("ArrowDown", true, -1.5, -2, 2, 0.1)).toBe(-2);
    expect(nextValue("PageUp", false, 1.5, -2, 2, 0.1)).toBe(2);
    expect(nextValue("Tab", false, 0, -2, 2, 0.1)).toBeNull();
  });
  it("rounds fractional and scientific steps without drift", () => {
    expect(nextValue("ArrowRight", false, 0.2, 0, 1, 0.1)).toBe(0.3);
    expect(roundValue(0.327, 0, 1, 0.05)).toBe(0.35);
    expect(roundValue(0.00000032, 0, 1, 1e-7)).toBe(0.0000003);
    expect(roundValue(100, -0.5, 1.5, 0.1)).toBe(1.5);
  });
});
