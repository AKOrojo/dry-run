// Map layer visibility and opacity, shared by the sidebar and the map stage.
import { useSyncExternalStore } from "react";

export type LayerKey = "water" | "buildings" | "roads" | "places" | "arrival" | "route" | "photos" | "terrain" | "imagery" | "boundary";
export type LayerState = { on: boolean; opacity: number };
export type ImageryMode = "colour" | "greyscale";
/** Aerial: Bing imagery on World Terrain. Photoreal: Google Photorealistic 3D Tiles (via ion), water draped on it. */
export type Basemap = "aerial" | "photoreal";
export type LayersState = Record<LayerKey, LayerState> & { imageryMode: ImageryMode; basemap: Basemap };

let state: LayersState = {
  water: { on: true, opacity: 1 },
  buildings: { on: true, opacity: 1 },
  roads: { on: true, opacity: 1 },
  places: { on: true, opacity: 1 },
  arrival: { on: false, opacity: 0.8 },
  route: { on: true, opacity: 1 },
  photos: { on: true, opacity: 1 },
  terrain: { on: true, opacity: 1 },
  imagery: { on: true, opacity: 1 },
  boundary: { on: true, opacity: 1 },
  imageryMode: "colour",
  basemap: "photoreal",
};
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const layers = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useLayers = () => useSyncExternalStore(layers.subscribe, layers.get);

export function setLayer(key: LayerKey, patch: Partial<LayerState>) {
  state = { ...state, [key]: { ...state[key], ...patch } };
  emit();
}
export function setBasemap(basemap: Basemap) {
  state = { ...state, basemap };
  emit();
}
export function setImageryMode(mode: ImageryMode) {
  state = { ...state, imageryMode: mode };
  emit();
}
