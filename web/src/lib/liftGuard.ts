// A long press opens a menu while the finger is still down. When it lifts, the browser sends a click to whatever is now
// under it (the sheet's backdrop, or an item that slid under the finger), which would close or run the menu at once.
// liftGuard keeps the menu's outside-close off until that pointer has ended, and swallows the one click that follows.
// Only touch and pen count: a mouse's right-click sends no click on release, so a swallow would eat the next real one.

/** Arms outside-close when no pointerup or pointercancel arrives (a lost event must not leave the menu unclosable). It
 *  waits again while the finger is still known to be down (a long hold), up to LIFT_ARM_MAX_MS. */
export const LIFT_ARM_FALLBACK_MS = 700;
export const LIFT_ARM_MAX_MS = 10_000;
/** How long after the lift the swallow waits for its click (it follows pointerup at once; some long presses send none). */
export const LIFT_CLICK_MS = 400;

const down = new Set<number>();
let tracking = false;
/** Follows which touch or pen pointers are down, document-wide (capture, so nothing stops it first). */
export function trackPointers(doc: Document = document) {
  if (tracking) return;
  tracking = true;
  doc.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") down.add(e.pointerId); }, true);
  const end = (e: PointerEvent) => { down.delete(e.pointerId); };
  doc.addEventListener("pointerup", end, true);
  doc.addEventListener("pointercancel", end, true);
}
export const fingerDown = () => down.size > 0;

const CAPTURE = { capture: true };

export type LiftGuard = { armed: () => boolean; dispose: () => void };

/** Starts guarding a menu that just opened. With no finger down it is armed at once and swallows nothing. */
export function liftGuard(target: EventTarget, stillDown: () => boolean, onArm: () => void = () => {}): LiftGuard {
  if (!stillDown()) return { armed: () => true, dispose: () => {} };
  const t0 = Date.now();
  let armed = false, swallowT: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { if (armed) return; armed = true; onArm(); };
  const swallow = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); unswallow(); };
  const unswallow = () => { clearTimeout(swallowT); target.removeEventListener("click", swallow, CAPTURE); };
  const unlisten = () => {
    clearTimeout(fallback);
    target.removeEventListener("pointerup", lift, CAPTURE);
    target.removeEventListener("pointercancel", lift, CAPTURE);
  };
  const lift = () => {
    unlisten();
    arm();
    swallowT = setTimeout(unswallow, LIFT_CLICK_MS);
  };
  target.addEventListener("pointerup", lift, CAPTURE);
  target.addEventListener("pointercancel", lift, CAPTURE);
  target.addEventListener("click", swallow, CAPTURE);
  let fallback: ReturnType<typeof setTimeout>;
  const check = () => {
    if (stillDown() && Date.now() - t0 < LIFT_ARM_MAX_MS) { fallback = setTimeout(check, LIFT_ARM_FALLBACK_MS); return; }
    unlisten();
    unswallow();
    arm();
  };
  fallback = setTimeout(check, LIFT_ARM_FALLBACK_MS);
  return {
    armed: () => armed,
    dispose: () => { unlisten(); unswallow(); },
  };
}
