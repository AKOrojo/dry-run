import { describe, expect, it } from "vitest";
import { scrubKey } from "./scrub";

describe("scrubKey", () => {
  const dur = 6 * 3600;  // step 600 s
  it("steps with the arrows, both pairs", () => {
    expect(scrubKey("ArrowRight", 1200, dur)).toBe(1800);
    expect(scrubKey("ArrowUp", 1200, dur)).toBe(1800);
    expect(scrubKey("ArrowLeft", 1200, dur)).toBe(600);
    expect(scrubKey("ArrowDown", 1200, dur)).toBe(600);
  });
  it("goes to the ends with Home and End, and stays inside them", () => {
    expect(scrubKey("Home", 5000, dur)).toBe(0);
    expect(scrubKey("End", 5000, dur)).toBe(dur);
    expect(scrubKey("ArrowLeft", 100, dur)).toBe(0);
    expect(scrubKey("ArrowRight", dur - 100, dur)).toBe(dur);
  });
  it("steps an hour with Page Up and Page Down, clamped to the run", () => {
    expect(scrubKey("PageUp", 1200, dur)).toBe(4800);
    expect(scrubKey("PageDown", 4800, dur)).toBe(1200);
    expect(scrubKey("PageDown", 1200, dur)).toBe(0);
    expect(scrubKey("PageUp", dur - 1200, dur)).toBe(dur);
    expect(scrubKey("PageUp", 0, 1800)).toBe(1800);  // a run shorter than an hour: to the end
  });
  it("steps at least a minute on a short run", () => {
    expect(scrubKey("ArrowRight", 0, 600)).toBe(60);
  });
  it("ignores other keys", () => {
    expect(scrubKey("Enter", 0, dur)).toBeNull();
  });
});
