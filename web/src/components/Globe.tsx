// Cesium viewer (owner: Eng B). Day 1: flat imagery + frame overlay.
// Day 2+: extruded buildings coloured by depth, route polylines, observation pins,
// polygon drawing for interventions, 2D/3D toggle.
import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { AOIManifest } from "../lib/api";

const DEPTH_EDGES = [0.05, 0.15, 0.3, 0.5, 1, 2];  // bin lower edges -> --depth-1..6
const cssColor = (name: string) =>
  Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
const buildingColor = (depth: number) => {
  if (!(depth >= 0.15)) return cssColor("--ink-muted");
  let bin = 0;
  DEPTH_EDGES.forEach((edge, i) => { if (depth >= edge) bin = i; });
  return cssColor(`--depth-${bin + 1}`);
};
const footprints = new Map<string, Promise<unknown>>();

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(response.statusText);
  return response.json();
}

// Resolves once the viewer's terrain provider is usable (immediately for the ellipsoid).
function terrainReady(terrain?: Cesium.Terrain): Promise<void> {
  if (!terrain || terrain.ready) return Promise.resolve();
  return new Promise((resolve) => {
    terrain.readyEvent.addEventListener(() => resolve());
    terrain.errorEvent.addEventListener(() => resolve());
  });
}

export function Globe({ aoi, frameUrl, frames, tS, ionToken, buildingsUrl, buildingDepthsUrl, onBuildingsStatus }: {
  aoi: AOIManifest; frameUrl?: string; frames?: { t_s: number; url: string }[]; tS?: number;
  ionToken: string; buildingsUrl?: string;
  buildingDepthsUrl?: string; onBuildingsStatus?: (status: string) => void;
}) {
  // Token comes from /api/config at runtime (dev: VITE_CESIUM_ION_TOKEN overrides).
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN || ionToken;
  if (token) Cesium.Ion.defaultAccessToken = token;
  const el = useRef<HTMLDivElement>(null);
  const viewer = useRef<Cesium.Viewer>();
  const terrainRef = useRef<Cesium.Terrain>();
  const layer = useRef<Cesium.ImageryLayer>();
  const frameLayers = useRef<{ t_s: number; layer: Cesium.ImageryLayer }[]>([]);
  const tSRef = useRef(tS);
  tSRef.current = tS;
  const [mode3D, setMode3D] = useState(true);
  const buildings = useRef<{ primitive: Cesium.Primitive; ids: string[] }>();
  const depths = useRef(new Map<string, number>());
  const [buildingStatus, setBuildingStatus] = useState("unavailable");
  const [depthFailed, setDepthFailed] = useState(false);

  const recolour = () => {
    const current = buildings.current;
    if (!current || current.primitive.isDestroyed() || !current.primitive.ready) return;
    for (const id of current.ids) {
      const depth = depths.current.get(id) ?? 0;
      const color = buildingColor(depth);
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
    terrainRef.current = token ? Cesium.Terrain.fromWorldTerrain() : undefined;
    const v = new Cesium.Viewer(el.current, {
      timeline: false, animation: false, baseLayerPicker: false, geocoder: false,
      homeButton: false, sceneModePicker: false, fullscreenButton: false, navigationHelpButton: false, infoBox: false,
      shadows: true,
      ...(token ? { terrain: terrainRef.current } : {}),
      // Without an ion token fall back to OSM tiles (attribution shown by Cesium credits).
      ...(token ? {} : { baseLayer: new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })) }),
    });
    v.shadowMap.softShadows = false;
    v.scene.globe.enableLighting = true;
    if (v.scene.fog) v.scene.fog.enabled = true;
    if (v.scene.skyAtmosphere) v.scene.skyAtmosphere.show = true;
    // Fixed daytime sun, not event time (Eng A): 14:00 local solar time at the AOI centre, 2026-07-15.
    v.clock.shouldAnimate = false;
    v.clock.currentTime = Cesium.JulianDate.fromDate(new Date(Date.UTC(2026, 6, 15) + (14 - (w + e) / 2 / 15) * 3600e3));
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
    pending.then(async (data) => {
      if (cancelled || v.isDestroyed()) return;
      const collection = data as { type?: string; features?: unknown[] };
      if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) throw new Error("Invalid footprints");
      const parsed: { id: string; points: number[][]; height: number }[] = [];
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
          parsed.push({ id: String(id), points, height });
          ids.add(String(id));
        } catch { /* Skip malformed footprints. */ }
      }
      // Ground = the drawn terrain at each centroid, sampled in one batch (0 on the ellipsoid or on failure).
      const ground = parsed.map(() => 0);
      try {
        await terrainReady(terrainRef.current);
        if (cancelled || v.isDestroyed()) return;
        if (!(v.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)) {
          const cartos = parsed.map((b) => Cesium.Cartographic.fromDegrees(
            b.points.reduce((a, p) => a + p[0], 0) / b.points.length, b.points.reduce((a, p) => a + p[1], 0) / b.points.length));
          const sampled = await Cesium.sampleTerrainMostDetailed(v.terrainProvider, cartos);
          sampled.forEach((c, i) => { if (Number.isFinite(c.height)) ground[i] = c.height; });
        }
      } catch { /* Keep ground at 0. */ }
      if (cancelled || v.isDestroyed()) return;
      const instances = parsed.map((b, i) => new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(b.points.flat())),
          height: ground[i], extrudedHeight: ground[i] + Math.max(3, b.height),
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        id: b.id,
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(buildingColor(0)) },
      }));
      if (!instances.length) { setBuildingStatus(ids.size.toLocaleString()); return; }
      primitive = v.scene.primitives.add(new Cesium.Primitive({
        geometryInstances: instances, appearance: new Cesium.PerInstanceColorAppearance({ flat: false, translucent: false }),
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

  const showNearest = () => {
    const list = frameLayers.current;
    if (!list.length) return;
    const t = tSRef.current ?? 0;
    let best = list[0];
    for (const f of list) if (Math.abs(f.t_s - t) < Math.abs(best.t_s - t)) best = f;
    for (const f of list) f.layer.show = f === best;
  };

  // Preloaded frames: every PNG is a hidden layer; playback only flips `show`.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !frames?.length) return;
    let cancelled = false;
    const added: Cesium.ImageryLayer[] = [];
    Promise.all(frames.map((f) => Cesium.SingleTileImageryProvider.fromUrl(f.url, { rectangle: rect }))).then((providers) => {
      if (cancelled || v.isDestroyed()) return;
      frameLayers.current = providers.map((p, i) => {
        const layer = v.imageryLayers.addImageryProvider(p);
        layer.alpha = 1.0;  // PNGs carry their own alpha ramp
        layer.show = false;
        added.push(layer);
        return { t_s: frames[i].t_s, layer };
      });
      showNearest();
    }).catch(() => { /* Frames unavailable: globe stays without overlay. */ });
    return () => {
      cancelled = true;
      frameLayers.current = [];
      if (!v.isDestroyed()) added.forEach((l) => v.imageryLayers.remove(l, true));
    };
  }, [frames]);

  useEffect(showNearest, [tS]);

  // Single-frame path, used when no preloaded frames are given.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !frameUrl || frames?.length) return;
    let cancelled = false;
    Cesium.SingleTileImageryProvider.fromUrl(frameUrl, { rectangle: rect }).then((p) => {
      if (cancelled) return;
      const next = v.imageryLayers.addImageryProvider(p);
      next.alpha = 1.0;
      if (layer.current) v.imageryLayers.remove(layer.current, true);
      layer.current = next;
    });
    return () => { cancelled = true; };
  }, [frameUrl, frames]);

  const morph = (to3D: boolean) => {
    const scene = viewer.current?.scene;
    if (!scene) return;
    if (to3D) scene.morphTo3D(0); else scene.morphTo2D(0);
    setMode3D(to3D);
  };

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={el} style={{ position: "absolute", inset: 0 }} />
      <div className="dr-mode-toggle">
        <button className="ft-btn ft-btn-ghost" aria-pressed={!mode3D} onClick={() => morph(false)}>2D</button>
        <button className="ft-btn ft-btn-ghost" aria-pressed={mode3D} onClick={() => morph(true)}>3D</button>
      </div>
    </div>
  );
}
