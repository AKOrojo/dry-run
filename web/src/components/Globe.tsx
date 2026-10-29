// Cesium viewer (owner: Eng B). Day 1: flat imagery + frame overlay.
// Day 2+: extruded buildings coloured by depth, route polylines, observation pins,
// polygon drawing for interventions, 2D/3D toggle.
import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { AOIManifest } from "../lib/api";

const BUILDING_GREY = Cesium.Color.fromCssColorString("#d3d3d3");
const BUILDING_LIGHT_BLUE = Cesium.Color.fromCssColorString("#87cefa");
const BUILDING_DARK_BLUE = Cesium.Color.fromCssColorString("#164b96");
const footprints = new Map<string, Promise<unknown>>();

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(response.statusText);
  return response.json();
}

export function Globe({ aoi, frameUrl, ionToken, buildingsUrl, buildingDepthsUrl, onBuildingsStatus }: {
  aoi: AOIManifest; frameUrl?: string; ionToken: string; buildingsUrl?: string;
  buildingDepthsUrl?: string; onBuildingsStatus?: (status: string) => void;
}) {
  // Token comes from /api/config at runtime (dev: VITE_CESIUM_ION_TOKEN overrides).
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN || ionToken;
  if (token) Cesium.Ion.defaultAccessToken = token;
  const el = useRef<HTMLDivElement>(null);
  const viewer = useRef<Cesium.Viewer>();
  const layer = useRef<Cesium.ImageryLayer>();
  const buildings = useRef<{ primitive: Cesium.Primitive; ids: string[] }>();
  const depths = useRef(new Map<string, number>());
  const [buildingStatus, setBuildingStatus] = useState("unavailable");
  const [depthFailed, setDepthFailed] = useState(false);

  const recolour = () => {
    const current = buildings.current;
    if (!current || current.primitive.isDestroyed() || !current.primitive.ready) return;
    for (const id of current.ids) {
      const depth = depths.current.get(id) ?? 0;
      const color = depth >= 0.5 ? BUILDING_DARK_BLUE : depth >= 0.15 ? BUILDING_LIGHT_BLUE : BUILDING_GREY;
      const attributes = current.primitive.getGeometryInstanceAttributes(id);
      if (attributes) attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(color);
    }
  };

  useEffect(() => {
    onBuildingsStatus?.(depthFailed ? "unavailable (flood depths)" : buildingStatus);
  }, [buildingStatus, depthFailed, onBuildingsStatus]);
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
    // Start oblique (30 deg, 3.5 km out): viewed straight down, the ~5 m buildings look flat.
    v.camera.lookAt(Cesium.Cartesian3.fromDegrees((w + e) / 2, (s + n) / 2, 0),
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-30), 3500));
    v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);  // release the lock so the user can pan freely
    viewer.current = v;
    return () => { layer.current = undefined; viewer.current = undefined; if (!v.isDestroyed()) v.destroy(); };
  }, [aoi.aoi_id, token]);

  useEffect(() => {
    const v = viewer.current;
    setBuildingStatus(buildingsUrl ? "loading…" : "unavailable");
    if (!v || !buildingsUrl) return;
    let cancelled = false;
    let primitive: Cesium.Primitive | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = footprints.get(buildingsUrl);
    if (!pending) {
      pending = fetchJson(buildingsUrl);
      pending.catch(() => footprints.delete(buildingsUrl));  // let a later mount retry a failed download
      footprints.set(buildingsUrl, pending);
    }
    pending.then((data) => {
      if (cancelled || v.isDestroyed()) return;
      const collection = data as { type?: string; features?: unknown[] };
      if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) throw new Error("Invalid footprints");
      const instances: Cesium.GeometryInstance[] = [];
      const ids = new Set<string>();
      for (const item of collection.features) {
        try {
          const feature = item as { properties?: { id?: unknown; height_m?: unknown }; geometry?: { type?: string; coordinates?: unknown[] } };
          const id = feature.properties?.id;
          const height = feature.properties?.height_m;
          if ((typeof id !== "string" && typeof id !== "number") || ids.has(String(id)) ||
              typeof height !== "number" || !Number.isFinite(height) || feature.geometry?.type !== "Polygon") continue;
          const ring = feature.geometry.coordinates?.[0];
          if (!Array.isArray(ring) || ring.length < 4) continue;
          if (!ring.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) continue;
          const points = ring.map((p) => [p[0], p[1]]);
          if (new Set(points.map((p) => p.join(","))).size < 3) continue;
          const geometry = new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(points.flat())),
            height: 0, extrudedHeight: Math.max(3, height), vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          });
          instances.push(new Cesium.GeometryInstance({ geometry, id: String(id), attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(BUILDING_GREY),
          } }));
          ids.add(String(id));
        } catch { /* Skip malformed footprints. */ }
      }
      if (!instances.length) { setBuildingStatus(ids.size.toLocaleString()); return; }
      primitive = v.scene.primitives.add(new Cesium.Primitive({
        geometryInstances: instances, appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
        asynchronous: true,
      }));
      buildings.current = { primitive: primitive!, ids: [...ids] };
      const ready = () => {
        if (cancelled || v.isDestroyed() || !primitive || primitive.isDestroyed()) return;
        if (!primitive.ready) { timer = setTimeout(ready, 50); return; }
        recolour();
        setBuildingStatus(ids.size.toLocaleString());
      };
      ready();
    }).catch(() => { if (!cancelled && !v.isDestroyed()) setBuildingStatus("unavailable"); });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (buildings.current?.primitive === primitive) buildings.current = undefined;
      if (primitive && !v.isDestroyed()) v.scene.primitives.remove(primitive);
    };
  }, [buildingsUrl, aoi.aoi_id, token]);

  useEffect(() => {
    let cancelled = false;
    depths.current = new Map();
    setDepthFailed(false);
    recolour();
    if (buildingDepthsUrl) fetchJson(buildingDepthsUrl).then((data) => {
      if (cancelled) return;
      const values = data as { ids?: unknown[]; max_depth_m?: unknown[] };
      if (!Array.isArray(values?.ids) || !Array.isArray(values.max_depth_m) || values.ids.length !== values.max_depth_m.length) throw new Error("Invalid depths");
      const next = new Map<string, number>();
      values.ids.forEach((id, i) => {
        const depth = values.max_depth_m![i];
        if ((typeof id === "string" || typeof id === "number") && typeof depth === "number" && Number.isFinite(depth)) next.set(String(id), depth);
      });
      depths.current = next;
      recolour();
    }).catch(() => { if (!cancelled) setDepthFailed(true); });
    return () => { cancelled = true; };
  }, [buildingDepthsUrl]);

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
