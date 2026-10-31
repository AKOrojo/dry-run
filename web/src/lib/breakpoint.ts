// Layout breakpoints (design board 13), decided by the viewport width only, never by the user agent:
// phone under 600 px, tablet 600-1023 px, desktop from 1024 px.
import { useSyncExternalStore } from "react";

export type Breakpoint = "phone" | "tablet" | "desktop";
export const PHONE_BELOW = 600;
export const DESKTOP_FROM = 1024;

export const breakpointFor = (width: number): Breakpoint => (width < PHONE_BELOW ? "phone" : width < DESKTOP_FROM ? "tablet" : "desktop");

const QUERIES = [`(max-width: ${PHONE_BELOW - 1}px)`, `(max-width: ${DESKTOP_FROM - 1}px)`];

function current(): Breakpoint {
  if (typeof window === "undefined") return "desktop";
  // matchMedia agrees with the CSS media queries (scrollbars, zoom) where innerWidth can differ by a pixel.
  const [phone, below] = QUERIES.map((q) => window.matchMedia?.(q).matches);
  if (phone === undefined) return breakpointFor(window.innerWidth);
  return phone ? "phone" : below ? "tablet" : "desktop";
}

function subscribe(f: () => void) {
  const ms = QUERIES.map((q) => window.matchMedia?.(q)).filter((m): m is MediaQueryList => !!m);
  ms.forEach((m) => m.addEventListener("change", f));
  window.addEventListener("resize", f);
  return () => { ms.forEach((m) => m.removeEventListener("change", f)); window.removeEventListener("resize", f); };
}

export const useBreakpoint = () => useSyncExternalStore(subscribe, current, () => "desktop" as Breakpoint);

/** A finger, not a mouse: no hover hints, no drag hint. */
const COARSE = "(pointer: coarse)";
const touchNow = () => typeof window !== "undefined" && !!window.matchMedia?.(COARSE).matches;
function subscribeTouch(f: () => void) {
  const m = window.matchMedia?.(COARSE);
  m?.addEventListener("change", f);
  return () => m?.removeEventListener("change", f);
}
export const useTouch = () => useSyncExternalStore(subscribeTouch, touchNow, () => false);
