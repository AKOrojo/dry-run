// Cesium viewer (owner: Eng B). Day 1: flat imagery + frame overlay.
// Day 2+: extruded buildings coloured by depth, route polylines, observation pins,
// polygon drawing for interventions, 2D/3D toggle.
import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { AOIManifest } from "../lib/api";

export function Globe({ aoi, frameUrl, ionToken }: { aoi: AOIManifest; frameUrl?: string; ionToken: string }) {
  // Token comes from /api/config at runtime (dev: VITE_CESIUM_ION_TOKEN overrides).
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN || ionToken;
  if (token) Cesium.Ion.defaultAccessToken = token;
  const el = useRef<HTMLDivElement>(null);
  const viewer = useRef<Cesium.Viewer>();
  const layer = useRef<Cesium.ImageryLayer>();
  const [w, s, e, n] = aoi.grid.bounds_wgs84;
  const rect = Cesium.Rectangle.fromDegrees(w, s, e, n);

  useEffect(() => {
    if (!el.current) return;
    const v = new Cesium.Viewer(el.current, {
      timeline: false, animation: false, baseLayerPicker: false, geocoder: false,
      homeButton: false, sceneModePicker: true, navigationHelpButton: false, infoBox: false,
      // Without an ion token fall back to OSM tiles (attribution shown by Cesium credits).
      ...(token ? {} : { baseLayer: new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })) }),
    });
    v.camera.flyTo({ destination: rect, duration: 0 });
    viewer.current = v;
    return () => { layer.current = undefined; v.destroy(); };
  }, [aoi.aoi_id, token]);

  // Swap the depth overlay when the frame changes. Preload next frames in Day 2 polish to avoid flicker.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !frameUrl) return;
    let cancelled = false;
    Cesium.SingleTileImageryProvider.fromUrl(frameUrl, { rectangle: rect }).then((p) => {
      if (cancelled) return;
      const next = v.imageryLayers.addImageryProvider(p);
      next.alpha = 0.85;
      if (layer.current) v.imageryLayers.remove(layer.current, true);
      layer.current = next;
    });
    return () => { cancelled = true; };
  }, [frameUrl]);

  return <div ref={el} style={{ position: "absolute", inset: 0 }} />;
}
