import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
const KEY = "dr_theme";

export function getTheme(): Theme {
  try { return localStorage.getItem(KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
}
export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* storage blocked */ }
}

const current = () => document.documentElement.dataset.theme;

/** Calls `cb` whenever the page theme changes (applyTheme sets data-theme on <html>). */
export function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}

/** The page theme as React state: effects that bake token colours into the map list it as a dependency. */
export function useTheme(): string | undefined {
  return useSyncExternalStore(subscribeTheme, current);
}

/** Memoises `read(name)` for the current theme; a theme change drops every value. */
export function perTheme<T>(read: (name: string) => T): (name: string) => T {
  let theme: string | undefined | null = null, seen = new Map<string, T>();  // null: not read yet
  return (name) => {
    const t = current();
    if (t !== theme) { theme = t; seen = new Map(); }
    let v = seen.get(name);
    if (v === undefined) seen.set(name, (v = read(name)));
    return v;
  };
}
