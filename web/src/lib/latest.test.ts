import { describe, expect, it } from "vitest";
import { latestOnly, newerOnly } from "./latest";

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

describe("newerOnly", () => {
  it("applies replies that arrive in order, even while later reads are pending", () => {
    const g = newerOnly();
    const a = g.start(), b = g.start(), c = g.start();
    expect(a()).toBe(true);
    expect(b()).toBe(true);
    expect(c()).toBe(true);
  });

  it("drops an older reply that arrives after a newer one applied", () => {
    const g = newerOnly();
    const a = g.start(), b = g.start();
    expect(b()).toBe(true);
    expect(a()).toBe(false);
  });

  it("a reply applies once", () => {
    const g = newerOnly();
    const a = g.start();
    expect(a()).toBe(true);
    expect(a()).toBe(false);
  });

  it("a reset drops every pending reply; reads after it apply", () => {
    const g = newerOnly();
    const a = g.start(), b = g.start();
    g.reset();
    expect(b()).toBe(false);
    expect(a()).toBe(false);
    const c = g.start();
    expect(c()).toBe(true);
  });
});
