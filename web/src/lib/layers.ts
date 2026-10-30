// Map layer visibility and opacity, shared by the sidebar and the map stage.
import { useSyncExternalStore } from "react";

export type LayerKey = "water" | "buildings" | "roads" | "places" | "arrival" | "route" | "photos" | "terrain" | "imagery" | "boundary" | "rain" | "closeups" | "weather";
export type LayerState = { on: boolean; opacity: number };
export type ImageryMode = "colour" | "greyscale";
/** Aerial: Bing imagery on World Terrain. Photoreal: Google Photorealistic 3D Tiles (via ion), water draped on it. */
export type Basemap = "aerial" | "photoreal";
/** Aerial imagery source: Bing (ion, everyone) or Google Map Tiles 2D (judges and the team; key from /api/tiles/google-key). */
export type AerialSource = "bing" | "google";
export type LayersState = Record<LayerKey, LayerState> & {
  imageryMode: ImageryMode; basemap: Basemap; aerial: AerialSource;
  /** Why the map is on Bing although Google was picked (no key, daily limit), or null. */ aerialNote: string | null;
  /** The server has a Google Map Tiles key (/api/config.google_tiles_available): offer Google as an Aerial source. */ googleAvailable: boolean;
};

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
  /** The rain preview: always shown before a run; "on" brings it back over a finished run for the same storm. */
  rain: { on: false, opacity: 1 },
  /** Dashed outlines and chips of the 3D close-ups a run has. */
  closeups: { on: true, opacity: 1 },
  /** Clouds and rain over the storm: always shown while a run simulates; "on" keeps them during playback of a finished run. */
  weather: { on: true, opacity: 1 },
  imageryMode: "colour",
  basemap: "photoreal",
  aerial: "bing",
  aerialNote: null,
  googleAvailable: false,
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
export function setAerial(aerial: AerialSource, aerialNote: string | null = null) {
  state = { ...state, aerial, aerialNote };
  emit();
}
export function setAerialNote(aerialNote: string | null) {
  state = { ...state, aerialNote };
  emit();
}
export function setGoogleAvailable(googleAvailable: boolean) {
  state = { ...state, googleAvailable };
  emit();
}
