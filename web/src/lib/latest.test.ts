import { describe, expect, it } from "vitest";
import { latestOnly } from "./latest";

describe("latestOnly", () => {
  it("keeps only the newest read current", () => {
    const start = latestOnly();
    const a = start();
    expect(a()).toBe(true);
    const b = start();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });

  it("a touch pin's read survives the hover bookkeeping a tap also fires (mouseleave)", () => {
    const hover = latestOnly(), pinTap = latestOnly();
    const pin = pinTap();
    hover(); hover();  // the compat mouseenter/mouseleave after a touch tap
    expect(pin()).toBe(true);
    const moved = pinTap();  // another tap moves the pin
    expect(pin()).toBe(false);
    expect(moved()).toBe(true);
  });
});
