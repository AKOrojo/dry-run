// Layout breakpoints (design board 13), decided by the viewport size only, never by the user agent:
// phone under 600 px wide, or under 500 px tall and under 1024 px wide (a phone on its side); tablet 600-1023 px;
// desktop from 1024 px.
import { useSyncExternalStore } from "react";

export type Breakpoint = "phone" | "tablet" | "desktop";
export const PHONE_BELOW = 600;
export const DESKTOP_FROM = 1024;
export const SHORT_BELOW = 500;

export const breakpointFor = (width: number, height = Infinity): Breakpoint =>
  (width < PHONE_BELOW || (height < SHORT_BELOW && width < DESKTOP_FROM) ? "phone" : width < DESKTOP_FROM ? "tablet" : "desktop");

const SHORT = `(max-height: ${SHORT_BELOW - 1}px)`;
const QUERIES = [`(max-width: ${PHONE_BELOW - 1}px), ${SHORT} and (max-width: ${DESKTOP_FROM - 1}px)`, `(max-width: ${DESKTOP_FROM - 1}px)`];

function current(): Breakpoint {
  if (typeof window === "undefined") return "desktop";
  // matchMedia agrees with the CSS media queries (scrollbars, zoom) where innerWidth can differ by a pixel.
  const [phone, below] = QUERIES.map((q) => window.matchMedia?.(q).matches);
  if (phone === undefined) return breakpointFor(window.innerWidth, window.innerHeight);
  return phone ? "phone" : below ? "tablet" : "desktop";
}

function subscribe(f: () => void) {
  const ms = QUERIES.map((q) => window.matchMedia?.(q)).filter((m): m is MediaQueryList => !!m);
  ms.forEach((m) => m.addEventListener("change", f));
  window.addEventListener("resize", f);
  return () => { ms.forEach((m) => m.removeEventListener("change", f)); window.removeEventListener("resize", f); };
}

export const useBreakpoint = () => useSyncExternalStore(subscribe, current, () => "desktop" as Breakpoint);

/** Under 500 px tall (a phone on its side): sheets open at full height only. */
const shortNow = () => typeof window !== "undefined" && !!window.matchMedia?.(SHORT).matches;
function subscribeShort(f: () => void) {
  const m = window.matchMedia?.(SHORT);
  m?.addEventListener("change", f);
  return () => m?.removeEventListener("change", f);
}
export const useShort = () => useSyncExternalStore(subscribeShort, shortNow, () => false);

/** A finger, not a mouse: no hover hints, no drag hint. */
const COARSE = "(pointer: coarse)";
const touchNow = () => typeof window !== "undefined" && !!window.matchMedia?.(COARSE).matches;
function subscribeTouch(f: () => void) {
  const m = window.matchMedia?.(COARSE);
  m?.addEventListener("change", f);
  return () => m?.removeEventListener("change", f);
}
export const useTouch = () => useSyncExternalStore(subscribeTouch, touchNow, () => false);
