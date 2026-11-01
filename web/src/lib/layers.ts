// Map layer visibility and opacity, shared by the sidebar and the map stage.
import { useSyncExternalStore } from "react";

export type LayerKey = "water" | "buildings" | "roads" | "places" | "arrival" | "route" | "photos" | "terrain" | "imagery" | "boundary" | "rain" | "closeups" | "flow" | "hazard" | "loads" | "profile" | "weather" | "drains";
export type LayerState = { on: boolean; opacity: number };
export type ImageryMode = "colour" | "greyscale";
/** Aerial: Bing imagery on World Terrain. Photoreal: Google Photorealistic 3D Tiles (via ion), water draped on it. */
import type { PhotorealDown } from "./photoreal";
export type Basemap = "aerial" | "photoreal";
/** Aerial imagery source: Bing (ion, everyone) or Google Map Tiles 2D (judges and the team; key from /api/tiles/google-key). */
export type AerialSource = "bing" | "google";
export type LayersState = Record<LayerKey, LayerState> & {
  imageryMode: ImageryMode; basemap: Basemap; aerial: AerialSource;
  /** Why the map is on Bing although Google was picked (no key, daily limit), or null. */ aerialNote: string | null;
  /** The server has a Google Map Tiles key (/api/config.google_tiles_available): offer Google as an Aerial source. */ googleAvailable: boolean;
  /** Google's Photorealistic 3D Tiles failed this session (lib/photoreal.ts): why, and when to offer them again. */ photorealDown: PhotorealDown | null;
  /** The map's "3D city unavailable" chip was dismissed: it is shown once per session. */ photorealChipDismissed: boolean;
  /** Bumped to open Layers and focus the Base map row (the chip's Details). */ basemapFocus: number;
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
  /** Flow and hazard (board 9): flow arrows, AIDR flood hazard, loads on buildings, the depth profile along a drawn line. All off until asked for. */
  flow: { on: false, opacity: 1 },
  hazard: { on: false, opacity: 1 },
  loads: { on: false, opacity: 1 },
  profile: { on: false, opacity: 1 },
  /** Drains (board 10): the drain network coloured by how full it is. Only offered on areas with a drain model. */
  drains: { on: true, opacity: 1 },
  imageryMode: "colour",
  basemap: "photoreal",
  aerial: "bing",
  aerialNote: null,
  googleAvailable: false,
  photorealDown: null,
  photorealChipDismissed: false,
  basemapFocus: 0,
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
/** Photoreal failed (down) or the user asked to try it again (null). */
export function setPhotorealDown(photorealDown: PhotorealDown | null) {
  state = { ...state, photorealDown };
  emit();
}
export function dismissPhotorealChip() {
  state = { ...state, photorealChipDismissed: true };
  emit();
}
/** Open Layers at the Base map row (Sidebar on desktop, the panel or sheet on smaller screens). */
export function focusBasemap() {
  state = { ...state, basemapFocus: state.basemapFocus + 1 };
  emit();
}
export function setGoogleAvailable(googleAvailable: boolean) {
  state = { ...state, googleAvailable };
  emit();
}
