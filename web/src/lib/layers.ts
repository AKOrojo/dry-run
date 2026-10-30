// Layer visibility and opacity, read by the map (MapStage) and written by the sidebar Layers card.
import { useSyncExternalStore } from "react";

export type LayerKey = "water" | "buildings" | "roads" | "places" | "arrival" | "route" | "photos" | "terrain" | "imagery";
export type LayerState = { on: boolean; opacity: number };
export type ImageryMode = "colour" | "greyscale";
export type LayersState = { layers: Record<LayerKey, LayerState>; imageryMode: ImageryMode };

let state: LayersState = {
  layers: {
    water: { on: true, opacity: 1 }, buildings: { on: true, opacity: 1 }, roads: { on: true, opacity: 1 },
    places: { on: true, opacity: 1 }, arrival: { on: false, opacity: 1 }, route: { on: false, opacity: 1 },
    photos: { on: false, opacity: 1 }, terrain: { on: true, opacity: 1 }, imagery: { on: true, opacity: 0.8 },
  },
  imageryMode: "colour",
};
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const layerStore = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => subs.delete(f); },
  setOn: (k: LayerKey, on: boolean) => { state = { ...state, layers: { ...state.layers, [k]: { ...state.layers[k], on } } }; emit(); },
  setOpacity: (k: LayerKey, opacity: number) => { state = { ...state, layers: { ...state.layers, [k]: { ...state.layers[k], opacity } } }; emit(); },
  setImageryMode: (imageryMode: ImageryMode) => { state = { ...state, imageryMode }; emit(); },
};

/** Reactive: { layers, imageryMode }. */
export const useLayers = () => useSyncExternalStore(layerStore.subscribe, layerStore.get);
/** Non-reactive snapshot of the per-layer map, for map code. */
export const layers = () => state.layers;
