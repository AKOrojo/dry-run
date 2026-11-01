import { describe, expect, it } from "vitest";
import { describedBy } from "./Tooltip";

describe("Tooltip description", () => {
  it("adds the tooltip to a field's own description instead of replacing it", () => {
    expect(describedBy("goal-count", "t1")).toBe("goal-count t1");
    expect(describedBy(undefined, "t1")).toBe("t1");
    expect(describedBy("  ", "t1")).toBe("t1");
  });
});
