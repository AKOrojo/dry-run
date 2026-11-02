import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIFT_ARM_FALLBACK_MS, LIFT_ARM_MAX_MS, LIFT_CLICK_MS, liftGuard } from "./liftGuard";

// The document stand-in: a target that records whether a click got through to a listener added after the guard's.
function setup(down: boolean) {
  const doc = new EventTarget();
  let finger = down, clicks = 0;
  // Added after the guard's own listener, as the backdrop's is in the page.
  const count = () => doc.addEventListener("click", () => clicks++);
  const click = () => { const e = new Event("click", { cancelable: true }); doc.dispatchEvent(e); return e.defaultPrevented; };
  const lift = (type = "pointerup") => { finger = false; doc.dispatchEvent(new Event(type)); };
  return { doc, stillDown: () => finger, click, lift, count, clicks: () => clicks };
}

describe("liftGuard", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("with no finger down (keyboard, mouse) is armed at once and swallows nothing", () => {
    const t = setup(false), g = liftGuard(t.doc, t.stillDown);
    t.count();
    expect(g.armed()).toBe(true);
    expect(t.click()).toBe(false);
    expect(t.clicks()).toBe(1);
  });

  it("arms on the finger's lift and swallows the one click that follows", () => {
    const t = setup(true), onArm = vi.fn(), g = liftGuard(t.doc, t.stillDown, onArm);
    t.count();
    expect(g.armed()).toBe(false);
    t.lift();
    expect(g.armed()).toBe(true);
    expect(onArm).toHaveBeenCalledTimes(1);
    expect(t.click()).toBe(true);   // the lift's click: swallowed
    expect(t.clicks()).toBe(0);
    expect(t.click()).toBe(false);  // the next tap gets through
    expect(t.clicks()).toBe(1);
  });

  it("arms on pointercancel too", () => {
    const t = setup(true), g = liftGuard(t.doc, t.stillDown);
    t.count();
    t.lift("pointercancel");
    expect(g.armed()).toBe(true);
  });

  it("stops waiting for the lift's click after LIFT_CLICK_MS (a long press that sends none)", () => {
    const t = setup(true);
    liftGuard(t.doc, t.stillDown);
    t.count();
    t.lift();
    vi.advanceTimersByTime(LIFT_CLICK_MS + 1);
    expect(t.click()).toBe(false);
    expect(t.clicks()).toBe(1);
  });

  it("keeps waiting through a long hold, then still swallows the lift's click", () => {
    const t = setup(true), g = liftGuard(t.doc, t.stillDown);
    t.count();
    vi.advanceTimersByTime(3 * LIFT_ARM_FALLBACK_MS);
    expect(g.armed()).toBe(false);
    t.lift();
    expect(g.armed()).toBe(true);
    expect(t.click()).toBe(true);
  });

  it("arms by the fallback when the lift was lost (the finger is no longer known to be down)", () => {
    let known = true;
    const t = setup(true), g = liftGuard(t.doc, () => known);
    t.count();
    vi.advanceTimersByTime(LIFT_ARM_FALLBACK_MS + 1);
    expect(g.armed()).toBe(false);  // still known to be down: waits again
    known = false;                  // the pointer ended without an event reaching the guard
    vi.advanceTimersByTime(LIFT_ARM_FALLBACK_MS);
    expect(g.armed()).toBe(true);
    expect(t.click()).toBe(false);
  });

  it("arms after LIFT_ARM_MAX_MS even if the finger never seems to lift", () => {
    const t = setup(true), g = liftGuard(t.doc, t.stillDown);
    t.count();
    vi.advanceTimersByTime(LIFT_ARM_MAX_MS + LIFT_ARM_FALLBACK_MS);
    expect(g.armed()).toBe(true);
    expect(t.click()).toBe(false);
  });

  it("dispose removes its listeners (a menu closed by a key before the lift)", () => {
    const t = setup(true), g = liftGuard(t.doc, t.stillDown);
    t.count();
    g.dispose();
    t.lift();
    expect(g.armed()).toBe(false);
    expect(t.click()).toBe(false);
    expect(t.clicks()).toBe(1);
  });
});
