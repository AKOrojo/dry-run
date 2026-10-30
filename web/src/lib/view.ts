// Page layout toggles (View menu) and the map's Cesium viewer, for the Share menu's image export.
import { useSyncExternalStore } from "react";
import type * as Cesium from "cesium";

export type ViewState = { sidebar: boolean; timeline: boolean };

let state: ViewState = { sidebar: true, timeline: true };
const subs = new Set<() => void>();

export const view = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useView = () => useSyncExternalStore(view.subscribe, view.get);
export function setView(patch: Partial<ViewState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

let viewer: Cesium.Viewer | undefined;
export const setMapViewer = (v: Cesium.Viewer | undefined) => { viewer = v; };

/** PNG data URL of the map as drawn now. Render and read in the same frame: the drawing buffer is not kept. */
export function mapImage(): string | null {
  if (!viewer || viewer.isDestroyed()) return null;
  viewer.scene.render();
  return viewer.canvas.toDataURL("image/png");
}

// Shareable view: ?aoi=&run=&t= (t in seconds from the run start).
export type SharedView = { aoi?: string; run?: string; t?: number };
export function readSharedView(): SharedView {
  try {
    const p = new URLSearchParams(window.location.search);
    const t = Number(p.get("t"));
    return { aoi: p.get("aoi") || undefined, run: p.get("run") || undefined, t: Number.isFinite(t) && t >= 0 ? t : undefined };
  } catch { return {}; }
}
export function sharedViewUrl({ aoi, run, t }: SharedView): string {
  const u = new URL(window.location.href);
  for (const k of ["aoi", "run", "t"]) u.searchParams.delete(k);
  if (aoi) u.searchParams.set("aoi", aoi);
  if (run) u.searchParams.set("run", run);
  if (run && t != null) u.searchParams.set("t", String(Math.round(t)));
  return u.toString();
}
