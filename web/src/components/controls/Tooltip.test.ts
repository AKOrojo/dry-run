import { describe, expect, it } from "vitest";
import { describedBy, describes } from "./Tooltip";

describe("Tooltip description", () => {
  it("adds the tooltip to a field's own description instead of replacing it", () => {
    expect(describedBy("goal-count", "t1")).toBe("goal-count t1");
    expect(describedBy(undefined, "t1")).toBe("t1");
    expect(describedBy("  ", "t1")).toBe("t1");
  });
});

describe("Tooltip is not read twice", () => {
  it("skips the description when it repeats the accessible name", () => {
    expect(describes("Orbit", undefined, "Orbit")).toBe(false);
    expect(describes(" orbit ", "Orbit", undefined)).toBe(false);
    expect(describes("Orbit", "Remove", "Orbit")).toBe(true);
    expect(describes("Fullscreen", "Exit fullscreen", undefined)).toBe(true);
    expect(describes("Remove", undefined, undefined)).toBe(true);
  });
});
