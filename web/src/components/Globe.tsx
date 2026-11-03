// Cesium viewer (owner: Eng B). Day 1: flat imagery + frame overlay.
// Day 2+: extruded buildings coloured by depth, route polylines, observation pins,
// polygon drawing for interventions, 2D/3D toggle.
import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { AOIManifest } from "../lib/api";
import { layers, OSM_NOTE, setAerial, setAerialNote, setBasemap, setIonDown, setPhotorealDown, useLayers } from "../lib/layers";
import { classify, errorLine, ionRefused, mayLoadPhotoreal } from "../lib/photoreal";
import { ApiError, getGoogleTilesKey } from "../lib/api";
import { areaCache } from "../lib/areaCache";
import { CESIUM_CHECKED } from "../lib/cesiumPin";
import { registerScene, requestRenderSoon, watchMotion } from "../lib/render";
import { perTheme, useTheme } from "../lib/theme";
import { buildingToken } from "../lib/buildings";
import { Notice } from "./Notice";
import { Button } from "./controls/Button";

// Photoreal tile detail: Cesium's default at rest, coarser while the camera moves, back REST_MS after it stops.
const TILES_REST_SSE = 16, TILES_MOVING_SSE = 24, REST_MS = 300;
// Google tileset loads run one at a time: overlapping loads share ion's cached endpoint and the second fails
// with "The Resource is already being fetched" (React's dev double effect, quick basemap toggles).
let googleQueue: Promise<unknown> = Promise.resolve();
/** Cesium ion asset "Google Maps 2D Satellite" (added to the account from the ion Asset Depot). */
// Read once per theme: a recolour walks every building.
const cssColor = perTheme((name) => Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim()));
const buildingColor = (depth: number) => cssColor(buildingToken(depth));
const footprints = areaCache<string, Promise<unknown>>();
type Footprint = { id: string; hierarchy: Cesium.PolygonHierarchy; height: number; centroid: Cesium.Cartographic };
// Parsed once per download, and the ground under each sampled once: Compare's second globe builds from the same lists.
const parsedFootprints = areaCache<string, Promise<Footprint[]>>();
const footprintGround = areaCache<string, Promise<number[]>>();
// Building work runs in slices of about SLICE_MS between frames, and in primitives of CHUNK houses: one primitive of a
// whole city packs, uploads and recolours in single tasks of hundreds of ms (Lagos: 69k houses).
const SLICE_MS = 8, CHUNK = 3000;
const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function parseFootprints(data: unknown): Promise<Footprint[]> {
  const collection = data as { type?: string; features?: unknown[] };
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) throw new Error("Invalid footprints");
  const parsed: Footprint[] = [];
  const ids = new Set<string>();
  let slice = performance.now();
  for (const item of collection.features) {
    if (performance.now() - slice > SLICE_MS) { await yieldToMain(); slice = performance.now(); }
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
      parsed.push({ id: String(id), height, hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(points.flat())),
        centroid: Cesium.Cartographic.fromDegrees(points.reduce((a, p) => a + p[0], 0) / points.length, points.reduce((a, p) => a + p[1], 0) / points.length) });
      ids.add(String(id));
    } catch { /* Skip malformed footprints. */ }
  }
  return parsed;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(response.statusText);
  return response.json();
}

/** A destroyed Cesium object keeps all its fields. Closures from earlier renders (a memoised callback keeps its whole
 *  render scope, and that scope's viewer) can keep it reachable, and with it every tile, primitive and texture: about
 *  55 MB per area switch. Drop the fields so at most an empty shell stays; isDestroyed() keeps answering true. */
function releaseDestroyed(o: object) {
  const d = o as { isDestroyed?: () => boolean } & Record<string, unknown>;
  if (!d.isDestroyed?.()) return;
  for (const k of Object.keys(d)) if (k !== "isDestroyed") { try { delete d[k]; } catch { /* non-configurable */ } }
}

// The workarounds below reach into Cesium internals checked on one version; on any other they are skipped.
const VERSION = (Cesium as unknown as { VERSION?: string }).VERSION;  // exported at runtime, missing from the d.ts
const internalsChecked = VERSION === CESIUM_CHECKED;
if (!internalsChecked) console.warn("leak workarounds skipped: Cesium " + VERSION);

// Cesium's request heap drops the request past its cap without clearing that slot, so one stale request (and the tile
// tree its priority callback closes over) outlives a destroyed tileset. Clear the slots past the heap's length.
function clearStaleRequests() {
  if (!internalsChecked) return;
  const heap = (Cesium.RequestScheduler as unknown as { requestHeap?: { length: number; internalArray: unknown[] } }).requestHeap;
  if (!heap) return;
  const slots = heap.internalArray;
  for (let i = heap.length; i < slots.length; i++) slots[i] = undefined;
}

// Resolves once the viewer's terrain provider is usable (immediately for the ellipsoid, or once World Terrain failed:
// a refusal often comes before the caller asks, and its errorEvent does not fire again for a late listener).
function terrainReady(terrain?: Cesium.Terrain): Promise<void> {
  if (!terrain || terrain.ready || terrainDown) return Promise.resolve();
  return new Promise((resolve) => {
    terrain.readyEvent.addEventListener(() => resolve());
    terrain.errorEvent.addEventListener(() => resolve());
  });
}

// Cesium ion refusing us (over quota, suspended, offline): OpenStreetMap stands in for its imagery (attribution through
// Cesium's credits), the ellipsoid for World Terrain. Neither is asked of ion again this session.
// OpenStreetMap's tile policy asks for its attribution on the map itself, not only behind "Data attribution".
const osm = () => new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/",
  credit: new Cesium.Credit('© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors', true) });
let terrainDown = false;
/** The area whose default basemap was last applied. */
let basemapAoi: string | undefined;
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** `p` in place of the base imagery layer, with its show, alpha, saturation and brightness. */
function swapBase(v: Cesium.Viewer, p: Cesium.ImageryProvider) {
  const old = v.imageryLayers.get(0);
  const layer = v.imageryLayers.addImageryProvider(p, 0);
  layer.show = old.show; layer.alpha = old.alpha; layer.saturation = old.saturation; layer.brightness = old.brightness;
  v.imageryLayers.remove(old, true);
  return layer;
}
// Google's 3D tiles through ion (what createGooglePhotorealistic3DTileset does without a key, and as it does, the asset
// is asked of ion once a session): a refusal by ion itself is tagged, so classify() tells it from one by Google.
let photorealAsset: Promise<Cesium.IonResource> | undefined;
function photorealTileset(options: Cesium.Cesium3DTileset.ConstructorOptions) {
  photorealAsset ??= Cesium.IonResource.fromAssetId(2275207);
  return photorealAsset.catch((e) => { throw ionRefused(e); })
    .then((res) => Cesium.Cesium3DTileset.fromUrl(res, { cacheBytes: 1536 * 1024 * 1024, maximumCacheOverflowBytes: 1024 * 1024 * 1024, enableCollision: true, ...options }));
}

export function Globe({ aoi, frameUrl, frames, framesB, split, tS, ionToken, buildingsUrl, buildingDepthsUrl, onBuildingsStatus, onViewer, onRestart }: {
  aoi: AOIManifest; frameUrl?: string; frames?: { t_s: number; url: string }[]; tS?: number;
  /** Compare swipe: frames drawn right of `split` (0..1 of the width); `frames` are then drawn left of it. */
  framesB?: { t_s: number; url: string }[]; split?: number;
  ionToken: string; buildingsUrl?: string;
  buildingDepthsUrl?: string; onBuildingsStatus?: (status: string) => void;
  /** Called with the Cesium viewer once created (and with undefined when it is destroyed). */
  onViewer?: (viewer: Cesium.Viewer | undefined) => void;
  /** "Restart map" after the map stopped drawing: the parent mounts a new Globe (a new viewer, every layer added again). */
  onRestart: () => void;
}) {
  // Token comes from /api/config at runtime (dev: VITE_CESIUM_ION_TOKEN overrides).
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN || ionToken;
  if (token) Cesium.Ion.defaultAccessToken = token;
  // Dev only: the ion token is URL-restricted to the live site, so local runs can route ion through a
  // referer-setting proxy (VITE_ION_SERVER, e.g. /ion/ proxied by vite.live.config.ts).
  if (import.meta.env.DEV && import.meta.env.VITE_ION_SERVER) Cesium.Ion.defaultServer = new URL(import.meta.env.VITE_ION_SERVER, window.location.href).href;
  const el = useRef<HTMLDivElement>(null);
  const [stopped, setStopped] = useState<"error" | "lost" | null>(null);
  const onRestartRef = useRef(onRestart);
  onRestartRef.current = onRestart;
  const viewer = useRef<Cesium.Viewer>();
  /** Google 2D imagery is the base layer right now (so switching back to Bing must swap it out). */
  const googleShown = useRef(false);
  const terrainRef = useRef<Cesium.Terrain>();
  const layer = useRef<Cesium.ImageryLayer>();
  const frameLayers = useRef<{ t_s: number; layer: Cesium.ImageryLayer; url: string }[]>([]);
  const frameLayersB = useRef<{ t_s: number; layer: Cesium.ImageryLayer; url: string }[]>([]);
  /** Water on the photoreal mesh: one textured ground primitive classifying the 3D tiles, its image set to the current frame. */
  const drape = useRef<{ prim: Cesium.GroundPrimitive; url?: string; key?: string }>();
  const photoreal = useRef<Cesium.Cesium3DTileset>();
  const photorealBuildings = useRef(false);
  /** Metres to raise our buildings so they stand on the photoreal mesh instead of under it (0 on aerial). */
  const meshLift = useRef(0);
  const applyLift = (only?: Chunk) => {
    const [cw, cs, ce, cn] = aoi.grid.bounds_wgs84;
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(Cesium.Cartesian3.fromDegrees((cw + ce) / 2, (cs + cn) / 2), new Cesium.Cartesian3());
    const lift = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.multiplyByScalar(up, meshLift.current, up));
    for (const c of only ? [only] : buildings.current) if (!c.primitive.isDestroyed()) c.primitive.modelMatrix = lift;
    requestRenderSoon();
  };
  photorealBuildings.current = !!aoi.photoreal_buildings;
  const splitRef = useRef(split ?? 0.5);
  splitRef.current = split ?? 0.5;
  const tSRef = useRef(tS);
  tSRef.current = tS;
  const layerState = useLayers();
  const layerRef = useRef(layerState);
  layerRef.current = layerState;
  type Chunk = { primitive: Cesium.Primitive; ids: string[] };
  const buildings = useRef<Chunk[]>([]);
  const depths = useRef(new Map<string, number>());
  const theme = useTheme();
  const [buildingStatus, setBuildingStatus] = useState("unavailable");
  const [depthFailed, setDepthFailed] = useState(false);

  // A theme, layer or depth change repaints every house: a chunk per slice, so a whole city does not block a frame
  // (entering Compare repaints the main map's houses for the pair). A newer repaint replaces one still running.
  const recolourGen = useRef(0);
  const recolour = () => {
    const gen = ++recolourGen.current, list = [...buildings.current];
    let i = 0;
    const step = () => {
      if (gen !== recolourGen.current) return;
      const slice = performance.now();
      while (i < list.length && performance.now() - slice < SLICE_MS) paint(list[i++]);
      requestRenderSoon();
      if (i < list.length) setTimeout(step, 0);
    };
    step();
  };
  const paint = (current: Chunk) => {
    if (current.primitive.isDestroyed() || !current.primitive.ready) return;
    // Over Google's mesh, our boxes only make sense where the mesh has real buildings (only flooded ones are drawn
    // there); where it is 2.5D (Lagos, Texas) its blobs swallow them, so the Aerial basemap carries our 3D houses.
    current.primitive.show = layerRef.current.buildings.on && (layerRef.current.basemap !== "photoreal" || photorealBuildings.current);
    // Opaque buildings cast and take shadows; only a faded layer needs the translucent pass.
    // Over the photoreal mesh the globe is translucent; opaque buildings then lose the depth test, so draw them in the translucent pass.
    const translucent = layerRef.current.buildings.opacity < 1 || layerRef.current.basemap === "photoreal";
    if ((current.primitive.appearance as Cesium.PerInstanceColorAppearance).translucent !== translucent) {
      current.primitive.appearance = new Cesium.PerInstanceColorAppearance({ flat: false, translucent });
    }
    for (const id of current.ids) {
      const depth = depths.current.get(id) ?? 0;
      const dryHidden = layerRef.current.basemap === "photoreal" && photorealBuildings.current && !(depth >= 0.15);
      const color = buildingColor(depth).withAlpha(dryHidden ? 0 : layerRef.current.buildings.opacity);
      const attributes = current.primitive.getGeometryInstanceAttributes(id);
      if (attributes) attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(color);
    }
  };

  // Building colours are tokens baked into instance attributes: a theme switch repaints them.
  useEffect(() => { recolour(); }, [theme]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onBuildingsStatus?.(depthFailed ? "unavailable (flood depths)" : buildingStatus);
  }, [buildingStatus, depthFailed, onBuildingsStatus]);
  const [w, s, e, n] = aoi.grid.bounds_wgs84;
  const rect = Cesium.Rectangle.fromDegrees(w, s, e, n);

  useEffect(() => {
    if (!el.current) return;
    const ionImagery = !!token && !layers.get().ionDown;
    terrainRef.current = token && !terrainDown ? Cesium.Terrain.fromWorldTerrain() : undefined;
    const v = new Cesium.Viewer(el.current, {
      timeline: false, animation: false, baseLayerPicker: false, geocoder: false,
      homeButton: false, sceneModePicker: false, fullscreenButton: false, navigationHelpButton: false, infoBox: false,
      shadows: true,
      // Render on demand: an idle map draws nothing. Cesium renders for camera moves and tile loads; lib/render.ts asks
      // for frames when our own state changes.
      requestRenderMode: true, maximumRenderTimeChange: Infinity,
      ...(terrainRef.current ? { terrain: terrainRef.current } : {}),
      // Without an ion token (or with ion refusing this session) OSM tiles (attribution shown by Cesium credits).
      ...(ionImagery ? {} : { baseLayer: new Cesium.ImageryLayer(osm()) }),
    });
    // ion refuses: a flat globe (buildings stay at ground 0), and the street map unless Google's imagery is showing.
    terrainRef.current?.errorEvent.addEventListener((err) => {
      terrainDown = true;
      console.warn(`Cesium World Terrain is unavailable; the globe stays flat. ${why(err)}`);
      // Cesium leaves the globe without a terrain provider until the terrain is ready, and draws no globe meanwhile.
      if (!v.isDestroyed()) { v.scene.globe.terrainProvider = new Cesium.EllipsoidTerrainProvider(); v.scene.requestRender(); }
    });
    if (ionImagery) v.imageryLayers.get(0).errorEvent.addEventListener((err) => {
      console.warn(`Cesium ion imagery is unavailable; showing the street map. ${why(err)}`);
      if (!v.isDestroyed() && !googleShown.current) { swapBase(v, osm()); v.scene.requestRender(); }
      setIonDown();
    });
    // Render settings from the design prototype: soft 4k shadows, a lower sun, sharper terrain and
    // full device resolution (the browser-recommended scale renders at CSS pixels and blurs on HiDPI).
    v.shadowMap.softShadows = true;
    v.shadowMap.size = 2048;
    v.shadowMap.darkness = 0.45;
    v.useBrowserRecommendedResolution = false;
    v.resolutionScale = Math.min(window.devicePixelRatio || 1, 2);
    v.scene.globe.maximumScreenSpaceError = 1.5;
    v.scene.globe.tileCacheSize = 1000;
    v.scene.globe.enableLighting = true;
    if (v.scene.fog) v.scene.fog.enabled = true;
    if (v.scene.skyAtmosphere) v.scene.skyAtmosphere.show = true;
    // Fixed daytime sun, not event time (Eng A): 16:00 local solar time at the AOI centre, 2026-07-15.
    v.clock.shouldAnimate = false;
    v.clock.currentTime = Cesium.JulianDate.fromDate(new Date(Date.UTC(2026, 6, 15) + (16 - (w + e) / 2 / 15) * 3600e3));
    // Start oblique (30 deg, 3.5 km out): viewed straight down, the ~5 m buildings look flat.
    v.camera.lookAt(Cesium.Cartesian3.fromDegrees((w + e) / 2, (s + n) / 2, 0),
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-30), 3500));
    v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);  // release the lock so the user can pan freely
    // Orbit, tilt and zoom stay above the ground; the pitch clamp lives in MapStage.
    const ctl = v.scene.screenSpaceCameraController;
    ctl.enableCollisionDetection = true;
    // 3D-app mouse map: left-drag pans, right-drag (or middle, or Ctrl+left) orbits and tilts, scroll zooms.
    const E = Cesium.CameraEventType;
    ctl.tiltEventTypes = [E.RIGHT_DRAG, E.MIDDLE_DRAG, { eventType: E.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.CTRL }];
    ctl.zoomEventTypes = [E.WHEEL, E.PINCH];
    ctl.lookEventTypes = [{ eventType: E.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.SHIFT }];
    ctl.minimumZoomDistance = 150;
    ctl.maximumZoomDistance = 25000;
    // Rendering stops on any exception in the render loop: a scene render error or a throw in a pre/postRender listener,
    // which Scene.render does not catch. Both reach the widget's showErrorPanel; ours logs the stack (in production too, so
    // the next one says where it came from) and shows "The map stopped drawing" instead of Cesium's panel.
    let resumes = 0;
    v.cesiumWidget.showErrorPanel = (_title: string, _message: string | undefined, err: unknown) => {
      // A failed request (a sky-box face, under a network burst) is thrown once from update() and then dropped: the map
      // draws on without it. A few per globe; past that, the panel.
      if (err instanceof Cesium.RequestErrorEvent && resumes < 3 && !v.isDestroyed()) {
        resumes++;
        console.warn(`Cesium render skipped a failed request (area ${aoi.aoi_id}): ${errorText(err)}`);
        v.useDefaultRenderLoop = true;
        v.scene.requestRender();
        return;
      }
      console.error(`Cesium render error (area ${aoi.aoi_id}, basemap ${layerRef.current.basemap}): ${errorText(err)}`);
      if (import.meta.env.DEV) { const w = window as unknown as { __renderErrors?: number }; w.__renderErrors = (w.__renderErrors ?? 0) + 1; }
      setStopped("error");
    };
    // A lost WebGL context (GPU reset, memory pressure): nothing draws until a new viewer is made. preventDefault lets the
    // browser restore it; the map then restarts by itself.
    const lost = (e: Event) => { e.preventDefault(); console.error(`WebGL context lost (area ${aoi.aoi_id})`); setStopped("lost"); };
    const restored = () => { console.error(`WebGL context restored (area ${aoi.aoi_id}): restarting the map`); onRestartRef.current(); };
    v.canvas.addEventListener("webglcontextlost", lost);
    v.canvas.addEventListener("webglcontextrestored", restored);
    const unregister = registerScene(v.scene, v.imageryLayers);
    // One more frame once the camera rests: overlays that sample the view on a throttle (scale bar, flow-arrow zoom,
    // drain inlets) then see its final pose.
    const offMotion = watchMotion(v.scene, () => {}, () => { if (!v.isDestroyed()) v.scene.requestRender(); }, REST_MS);
    // Pointer input can change hover highlights drawn in the scene.
    const node = el.current;
    node.addEventListener("pointermove", requestRenderSoon);
    node.addEventListener("pointerup", requestRenderSoon);
    viewer.current = v;
    if (import.meta.env.DEV) (window as unknown as { __viewer?: Cesium.Viewer }).__viewer = v;
    onViewer?.(v);
    return () => {
      offMotion(); unregister();
      v.canvas.removeEventListener("webglcontextlost", lost);
      v.canvas.removeEventListener("webglcontextrestored", restored);
      node.removeEventListener("pointermove", requestRenderSoon);
      node.removeEventListener("pointerup", requestRenderSoon);
      layer.current = undefined; viewer.current = undefined; onViewer?.(undefined);
      const scene = v.scene;
      const { frameState: frame, context } = scene as unknown as { frameState: Record<string, unknown>; context: object };  // 1.146 layout
      if (!v.isDestroyed()) v.destroy();
      releaseDestroyed(scene); releaseDestroyed(v);
      // Cesium module-level scratch objects keep the last frame state (model draw commands) and the last glTF texture
      // job (its WebGL context). Emptied, they no longer hold the photoreal tile tree or this context's shader cache.
      if (internalsChecked) {
        for (const k of Object.keys(frame)) delete frame[k];
        releaseDestroyed(context);
      }
      clearStaleRequests();
      if (import.meta.env.DEV) {
        const w = window as unknown as { __viewer?: Cesium.Viewer };
        if (w.__viewer === v) w.__viewer = undefined;
      }
    };
  }, [aoi.aoi_id, token]);

  useEffect(() => {
    const v = viewer.current;
    setBuildingStatus(buildingsUrl ? "loading…" : "unavailable");
    if (!v || !buildingsUrl) return;
    let cancelled = false;
    const chunks: Chunk[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let pending = footprints.get(buildingsUrl);
    if (!pending) {
      pending = fetchJson(buildingsUrl);
      pending.catch(() => footprints.delete(buildingsUrl));  // let a later mount retry a failed download
      footprints.set(buildingsUrl, pending);
    }
    let parsing = parsedFootprints.get(buildingsUrl);
    if (!parsing) {
      parsing = pending.then(parseFootprints);
      parsing.catch(() => parsedFootprints.delete(buildingsUrl));
      parsedFootprints.set(buildingsUrl, parsing);
    }
    const gone = () => cancelled || v.isDestroyed();
    parsing.then(async (parsed) => {
      if (gone()) return;
      // Ground = the drawn terrain at each centroid, sampled in one batch (0 on the ellipsoid or on failure).
      let ground = parsed.map(() => 0);
      try {
        await terrainReady(terrainRef.current);
        if (gone()) return;
        if (!(v.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)) {
          let sampling = footprintGround.get(buildingsUrl);
          if (!sampling) {
            // Level 12 (~30 m posts) matches the model grid, exists everywhere (World Terrain has no level 14 over
            // Lagos), and needs far fewer tiles than most-detailed.
            sampling = Cesium.sampleTerrain(v.terrainProvider, 12, parsed.map((b) => b.centroid.clone()))
              .then((sampled) => sampled.map((c) => (Number.isFinite(c.height) ? c.height : 0)));
            sampling.catch(() => footprintGround.delete(buildingsUrl));
            footprintGround.set(buildingsUrl, sampling);
          }
          ground = await sampling;
        }
      } catch { /* Keep ground at 0. */ }
      if (gone()) return;
      if (!parsed.length) { setBuildingStatus("0"); return; }
      let ready = 0;
      const add = (instances: Cesium.GeometryInstance[], ids: string[]) => {
        const primitive = v.scene.primitives.add(new Cesium.Primitive({
          geometryInstances: instances, appearance: new Cesium.PerInstanceColorAppearance({ flat: false, translucent: false }),
          shadows: Cesium.ShadowMode.ENABLED, asynchronous: true,
        })) as Cesium.Primitive;
        const chunk = { primitive, ids };
        chunks.push(chunk);
        buildings.current = [...buildings.current, chunk];
        const poll = () => {
          if (gone() || primitive.isDestroyed()) return;
          if (!primitive.ready) { const t = setTimeout(() => { timers.delete(t); poll(); }, 50); timers.add(t); return; }
          paint(chunk);
          applyLift(chunk);
          if (++ready * CHUNK >= parsed.length) setBuildingStatus(parsed.length.toLocaleString());
        };
        poll();
      };
      let instances: Cesium.GeometryInstance[] = [], ids: string[] = [];
      let slice = performance.now();
      for (let i = 0; i < parsed.length; i++) {
        const b = parsed[i];
        instances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: b.hierarchy, height: ground[i], extrudedHeight: ground[i] + Math.max(3, b.height),
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          id: b.id,
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(buildingColor(0)) },
        }));
        ids.push(b.id);
        if (instances.length === CHUNK || i === parsed.length - 1) { add(instances, ids); instances = []; ids = []; }
        if (performance.now() - slice > SLICE_MS) {
          await yieldToMain();
          if (gone()) return;
          slice = performance.now();
        }
      }
    }).catch(() => { if (!gone()) setBuildingStatus("unavailable"); });
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      buildings.current = buildings.current.filter((c) => !chunks.includes(c));
      if (!v.isDestroyed()) for (const c of chunks) v.scene.primitives.remove(c.primitive);
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

  const nearestOf = <T extends { t_s: number }>(list: T[]) => {
    const t = tSRef.current ?? 0;
    let best = list[0];
    for (const f of list) if (Math.abs(f.t_s - t) < Math.abs(best.t_s - t)) best = f;
    return best;
  };
  const showNearest = () => {
    const water = layerRef.current.water;
    const d = drape.current;
    const bestA = frameLayers.current.length ? nearestOf(frameLayers.current) : undefined;
    const bestB = frameLayersB.current.length ? nearestOf(frameLayersB.current) : undefined;
    for (const [list, best] of [[frameLayers.current, bestA], [frameLayersB.current, bestB]] as const) {
      for (const f of list) { f.layer.show = !d && water.on && f === best; f.layer.alpha = water.opacity; }
    }
    if (d && !d.prim.isDestroyed() && bestA) {
      d.prim.show = water.on;
      const m = (d.prim.appearance as Cesium.MaterialAppearance).material;
      if (bestB) drapeSwipe(d, bestA.url, bestB.url);
      else if (d.url !== bestA.url) { m.uniforms.image = bestA.url; d.url = bestA.url; d.key = undefined; }
      m.uniforms.color = new Cesium.Color(1, 1, 1, water.opacity);
    }
  };
  const swipe = !!framesB?.length;

  // Swipe on the photoreal mesh: the drape is one image, so A and B are composited into it, split along the
  // ground line under the screen split (flat ground keeps that line straight on screen, so it meets the handle).
  const images = useRef(new Map<string, Promise<HTMLImageElement>>());
  const image = (url: string) => {
    let p = images.current.get(url);
    if (!p) {
      p = new Promise((ok, bad) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => ok(im); im.onerror = bad; im.src = url; });
      images.current.set(url, p);
      if (images.current.size > 80) images.current.delete(images.current.keys().next().value as string);
    }
    return p;
  };
  const drapeSwipe = (d: NonNullable<typeof drape.current>, urlA: string, urlB: string) => {
    const v = viewer.current;
    if (!v || v.isDestroyed()) return;
    const c = v.canvas, x = splitRef.current * c.clientWidth;
    const ground = (px: number, py: number) => {
      const cart = v.camera.pickEllipsoid(new Cesium.Cartesian2(px, py));
      if (!cart) return null;
      const g = Cesium.Cartographic.fromCartesian(cart);
      return [Cesium.Math.toDegrees(g.longitude), Cesium.Math.toDegrees(g.latitude)] as const;
    };
    const top = ground(x, c.clientHeight * 0.35), bottom = ground(x, c.clientHeight), leftPt = ground(0, c.clientHeight);
    if (!top || !bottom || !leftPt) return;
    const key = `${urlA}|${urlB}|${top.map((q) => q.toFixed(5))}|${bottom.map((q) => q.toFixed(5))}`;
    if (d.key === key) return;
    d.key = key;
    Promise.all([image(urlA), image(urlB)]).then(([a, b]) => {
      if (d.key !== key || d.prim.isDestroyed()) return;
      const W = b.naturalWidth, H = b.naturalHeight;
      const px = ([lon, lat]: readonly [number, number]) => [((lon - w) / (e - w)) * W, ((n - lat) / (n - s)) * H] as const;
      const [p0, p1, pl] = [px(top), px(bottom), px(leftPt)];
      // Half-plane on the A side of the line p0-p1: extend the line far beyond the image, close on A's side.
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, far = 4 * (W + H);
      const side = Math.sign((pl[0] - p0[0]) * uy - (pl[1] - p0[1]) * ux) || 1;
      const nx = uy * side * far, ny = -ux * side * far;
      const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
      const g = canvas.getContext("2d")!;
      g.drawImage(b, 0, 0);
      g.save(); g.beginPath();
      g.moveTo(p0[0] - ux * far, p0[1] - uy * far); g.lineTo(p0[0] + ux * far, p0[1] + uy * far);
      g.lineTo(p0[0] + ux * far + nx, p0[1] + uy * far + ny); g.lineTo(p0[0] - ux * far + nx, p0[1] - uy * far + ny); g.closePath();
      g.clip(); g.clearRect(0, 0, W, H); g.drawImage(a, 0, 0); g.restore();
      (d.prim.appearance as Cesium.MaterialAppearance).material.uniforms.image = canvas;
      d.url = undefined;
      requestRenderSoon();
    }).catch(() => { /* frame image unavailable: keep the last drape */ });
  };
  useEffect(() => {
    const v = viewer.current;
    if (!v || v.isDestroyed() || !swipe) return;
    return v.scene.postRender.addEventListener(() => { if (drape.current) showNearest(); });
  }, [swipe]);

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
        layer.alpha = layerRef.current.water.opacity;  // PNGs carry their own alpha ramp
        layer.show = false;
        layer.splitDirection = swipe ? Cesium.SplitDirection.LEFT : Cesium.SplitDirection.NONE;
        added.push(layer);
        return { t_s: frames[i].t_s, layer, url: frames[i].url };
      });
      showNearest();
    }).catch(() => { /* Frames unavailable: globe stays without overlay. */ });
    return () => {
      cancelled = true;
      frameLayers.current = [];
      if (!v.isDestroyed()) added.forEach((l) => v.imageryLayers.remove(l, true));
    };
  }, [frames, swipe]);

  // Compare swipe: run B's frames on the right of the split, the same way.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !framesB?.length) return;
    let cancelled = false;
    const added: Cesium.ImageryLayer[] = [];
    Promise.all(framesB.map((f) => Cesium.SingleTileImageryProvider.fromUrl(f.url, { rectangle: rect }))).then((providers) => {
      if (cancelled || v.isDestroyed()) return;
      frameLayersB.current = providers.map((p, i) => {
        const layer = v.imageryLayers.addImageryProvider(p);
        layer.show = false;
        layer.splitDirection = Cesium.SplitDirection.RIGHT;
        added.push(layer);
        return { t_s: framesB[i].t_s, layer, url: framesB[i].url };
      });
      showNearest();
    }).catch(() => { /* B frames unavailable: only A shows. */ });
    return () => {
      cancelled = true;
      frameLayersB.current = [];
      if (!v.isDestroyed()) added.forEach((l) => v.imageryLayers.remove(l, true));
    };
  }, [framesB]);

  useEffect(() => {
    const v = viewer.current;
    if (v && !v.isDestroyed()) v.scene.splitPosition = split ?? 0.5;
  }, [split]);

  useEffect(showNearest, [tS, layerState.water.on, layerState.water.opacity]);

  // Default basemap per area: Google 3D where it has real buildings, otherwise our 3D houses on aerial imagery. Set when
  // the area changes, not per globe: Compare's second globe re-applying it flipped the shared basemap (and with it every
  // layer built per basemap) to Photoreal and, with ion down, straight back.
  useEffect(() => {
    if (basemapAoi === aoi.aoi_id) return;
    basemapAoi = aoi.aoi_id;
    setBasemap(aoi.photoreal_buildings ? "photoreal" : "aerial");
  }, [aoi.aoi_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Aerial imagery: Bing through ion for everyone; Google Map Tiles 2D when picked (judges and the team, our own key
  // from /api/tiles/google-key, capped per day). Google only replaces Bing once a real tile over the area loads, and
  // falls back to Bing when tiles keep failing (daily limit returns 429).
  useEffect(() => {
    const v = viewer.current;
    if (!v || v.isDestroyed() || !token) return;
    let cancelled = false;
    let added: Cesium.ImageryLayer | undefined;
    const swapIn = (p: Cesium.ImageryProvider) => swapBase(v, p);
    // Back from Google: Bing, or the street map once ion has refused (osmNote then says why).
    const toStreet = (osmNote: string) => { added = swapIn(osm()); setAerial("osm", osmNote); };
    const toBing = (note: string | null, osmNote = OSM_NOTE) => {
      if (layers.get().ionDown) { toStreet(osmNote); return; }
      Cesium.IonImageryProvider.fromAssetId(2).then((bing) => {
        if (cancelled || v.isDestroyed()) return;
        added = swapIn(bing);
        if (note) setAerial("bing", note);
      }).catch((err) => {
        if (cancelled || v.isDestroyed()) return;
        console.warn(`Cesium ion imagery is unavailable; showing the street map. ${why(err)}`);
        setIonDown();
        toStreet(osmNote);
      });
    };
    if (layerState.aerial !== "google") {
      // The viewer starts on ion's default (Bing); swap back only after Google was showing.
      if (googleShown.current) { googleShown.current = false; toBing(null); }
      return () => { cancelled = true; };
    }
    setAerialNote(null);
    getGoogleTilesKey().then((key) => Cesium.Google2DImageryProvider.fromUrl({ key, mapType: "satellite", region: aoi.aoi_id.startsWith("lagos") ? "NG" : "US" }))
      .then(async (p) => {
        if (cancelled || v.isDestroyed()) return;
        const centre = Cesium.Cartographic.fromDegrees((w + e) / 2, (s + n) / 2);
        const xy = p.tilingScheme.positionToTileXY(centre, 15);
        const probe = xy ? p.requestImage(xy.x, xy.y, 15) : undefined;
        if (!probe) throw new Error("no tile");
        await probe;
        if (cancelled || v.isDestroyed()) return;
        added = swapIn(p as unknown as Cesium.ImageryProvider);  // the d.ts types getTileCredits as possibly undefined
        googleShown.current = true;
        let failures = 0;
        p.errorEvent.addEventListener(() => {
          if (++failures !== 8 || cancelled || v.isDestroyed()) return;
          googleShown.current = false;
          toBing("Google reached today's tile limit; showing Bing.", "Google reached today's tile limit; showing the street map.");
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // A judge-key lockout (429, X-Auth-Lockout) also brings up the key box, which shows the countdown.
        const forbidden = err instanceof ApiError && (err.status === 403 || err.code === "forbidden" || !!err.lockout);
        setAerial("bing", forbidden ? "Google imagery needs the judge key."
          : layers.get().ionDown ? "Google imagery is not available right now; showing the street map." : "Google imagery is not available right now; showing Bing.");
        if (googleShown.current) { googleShown.current = false; toBing(null); }
      });
    return () => { cancelled = true; };
  }, [aoi.aoi_id, token, layerState.aerial]);

  // Photoreal basemap: Google 3D tiles through ion. The globe stays loaded (fully transparent) so terrain
  // heights and picking keep working; water is a textured ground primitive classifying the tiles (imagery layers on the tileset did not render).
  useEffect(() => {
    const v = viewer.current;
    if (!v || v.isDestroyed() || !token || layerState.basemap !== "photoreal") return;
    // Failed earlier this session: stay on aerial without asking Google again, area switches included, until Try 3D again.
    if (!mayLoadPhotoreal(layers.get().photorealDown)) { setBasemap("aerial"); return; }
    // ion refused us already this session: the 3D tiles come through ion too.
    if (layers.get().ionDown) { setPhotorealDown({ kind: "unavailable", status: null, retryAt: Infinity }); setBasemap("aerial"); return; }
    let cancelled = false;
    let tiles: Cesium.Cesium3DTileset | undefined;
    const g = v.scene.globe;
    const load = googleQueue.then(() => photorealTileset({
      maximumScreenSpaceError: TILES_REST_SSE,
      // Coarser tiles toward the screen edges, and no requests for tiles that will be out of view once they arrive.
      foveatedScreenSpaceError: true, cullRequestsWhileMoving: true,
    }));
    let offMotion: (() => void) | undefined;
    googleQueue = load.then(() => undefined, () => undefined);
    load.then((t) => {
      if (cancelled || v.isDestroyed()) { t.destroy(); return; }
      tiles = t;
      t.shadows = Cesium.ShadowMode.CAST_ONLY;  // receiving its own shadows gives moiré acne on the mesh
      v.scene.primitives.add(t);
      photoreal.current = t;
      offMotion = watchMotion(v.scene, () => { if (!t.isDestroyed()) t.maximumScreenSpaceError = TILES_MOVING_SSE; },
        () => { if (!t.isDestroyed()) { t.maximumScreenSpaceError = TILES_REST_SSE; v.scene.requestRender(); } }, REST_MS);
      if (import.meta.env.DEV) (window as unknown as { __tiles?: Cesium.Cesium3DTileset }).__tiles = t;
      const prim = new Cesium.GroundPrimitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.RectangleGeometry({ rectangle: rect, vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat }) }),
        appearance: new Cesium.MaterialAppearance({ material: Cesium.Material.fromType("Image", { image: Cesium.Material.DefaultImageId, color: Cesium.Color.WHITE }), flat: true, translucent: true }),
        classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        show: false,
      });
      v.scene.groundPrimitives.add(prim);
      drape.current = { prim };
      showNearest();
      // Google's mesh ground and World Terrain disagree by metres (tens in Lagos); our buildings sit on terrain
      // heights, so lift them by the median mesh-minus-terrain offset over a grid of probes.
      const liftToMesh = async () => {
        const probes: Cesium.Cartographic[] = [];
        for (let i = 1; i < 7; i++) for (let j = 1; j < 7; j++) probes.push(Cesium.Cartographic.fromDegrees(w + ((e - w) * i) / 7, s + ((n - s) * j) / 7));
        try {
          const own = buildings.current.map((c) => c.primitive);
          // Probe Google's mesh alone: the transparent globe is still pickable and would answer with its own height.
          const terrain = probes.map((c) => g.getHeight(c));
          g.show = false;
          let mesh: (Cesium.Cartographic | undefined)[];
          try { mesh = await v.scene.sampleHeightMostDetailed(probes.map((c) => c.clone()), own); } finally { if (!v.isDestroyed()) g.show = true; }
          if (cancelled || v.isDestroyed()) return;
          const diffs = mesh.map((c, k) => (c && Number.isFinite(c.height) ? c.height - (terrain[k] ?? NaN) : NaN)).filter(Number.isFinite).sort((a, b) => a - b);
          meshLift.current = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
          if (import.meta.env.DEV) console.warn(`photoreal lift ${meshLift.current.toFixed(1)} m from ${diffs.length} probes`);
          applyLift();
        } catch (err) { console.warn("Could not measure the photoreal ground offset; buildings stay on terrain:", err instanceof Error ? err.message : err); }
      };
      // Keep the aerial globe visible until the first Google tiles are in, so the map never goes blank.
      const hideGlobe = () => {
        if (cancelled || v.isDestroyed()) return;
        g.translucency.enabled = true;
        g.translucency.frontFaceAlpha = 0;
        g.translucency.backFaceAlpha = 0;
        g.showGroundAtmosphere = false;
        // The hidden globe only serves heights and picking: no imagery downloads, coarser terrain.
        if (v.imageryLayers.length) v.imageryLayers.get(0).show = false;
        g.maximumScreenSpaceError = 4;
        v.scene.requestRender();
      };
      const off = t.initialTilesLoaded.addEventListener(() => { off(); hideGlobe(); liftToMesh(); });
      recolour();
    }).catch((e) => {
      if (cancelled) return;
      // The basemap really is aerial now: the Layers control shows it, Photoreal is offered again per lib/photoreal.ts.
      const down = classify(e);
      (down.kind === "key" ? console.error : console.warn)(`Photoreal 3D unavailable, showing aerial imagery. ${errorLine(e)}`);
      setPhotorealDown(down);
      setBasemap("aerial");
    });
    return () => {
      cancelled = true;
      offMotion?.();
      photoreal.current = undefined;
      meshLift.current = 0;
      applyLift();
      const d = drape.current;
      drape.current = undefined;
      if (d && !v.isDestroyed()) v.scene.groundPrimitives.remove(d.prim);
      showNearest();
      if (!v.isDestroyed()) {
        g.translucency.enabled = false;
        g.showGroundAtmosphere = true;
        g.maximumScreenSpaceError = 1.5;
        if (v.imageryLayers.length) v.imageryLayers.get(0).show = layerRef.current.imagery.on;
        if (tiles) v.scene.primitives.remove(tiles);  // destroys it
      }
      // The tileset (destroyed by remove, or with the viewer) keeps its tiles until its fields go; see releaseDestroyed.
      if (tiles && !tiles.isDestroyed()) tiles.destroy();
      // Only once the viewer is gone: a live scene keeps the destroyed tileset in its height-callback bookkeeping for a
      // few frames, and reading a released field there stops rendering (basemap toggle, then a ground-clamped removal).
      if (tiles && v.isDestroyed()) releaseDestroyed(tiles);
      clearStaleRequests();
      if (import.meta.env.DEV) { const w = window as unknown as { __tiles?: Cesium.Cesium3DTileset }; if (w.__tiles === tiles) w.__tiles = undefined; }
      recolour();
    };
  }, [layerState.basemap, aoi.aoi_id, token]);

  // Base imagery: opacity, on/off and colour/greyscale.
  useEffect(() => {
    const v = viewer.current;
    if (!v || v.isDestroyed() || !v.imageryLayers.length) return;
    const base = v.imageryLayers.get(0);
    const { imagery, imageryMode } = layerState;
    base.show = imagery.on && !v.scene.globe.translucency.enabled;  // hidden under photoreal tiles: don't download
    base.alpha = imagery.opacity;
    base.saturation = imageryMode === "greyscale" ? 0 : 1;
    base.brightness = imageryMode === "greyscale" ? 0.9 : 1;
  }, [layerState.imagery.on, layerState.imagery.opacity, layerState.imageryMode, aoi.aoi_id, token]);

  useEffect(recolour, [layerState.buildings.on, layerState.buildings.opacity, layerState.basemap]);

  // Single-frame path, used when no preloaded frames are given.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !frameUrl || frames?.length) return;
    let cancelled = false;
    Cesium.SingleTileImageryProvider.fromUrl(frameUrl, { rectangle: rect }).then((p) => {
      if (cancelled || v.isDestroyed()) return;
      const next = v.imageryLayers.addImageryProvider(p);
      next.alpha = 1.0;
      if (layer.current) v.imageryLayers.remove(layer.current, true);
      layer.current = next;
    });
    return () => { cancelled = true; };
  }, [frameUrl, frames]);

  // Any change to the props or state above may change what the scene shows.
  useEffect(() => { requestRenderSoon(); });

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={el} style={{ position: "absolute", inset: 0 }} />
      {stopped && <MapStopped lost={stopped === "lost"} onRestart={onRestart} />}
    </div>
  );
}

/** The error and its stack as one line of text for the console (an Error's own toString drops the stack). */
export const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}` : String(err));

/** Shown over the map when it stopped drawing: what happened and a way back. */
function MapStopped({ lost, onRestart }: { lost: boolean; onRestart: () => void }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      background: "color-mix(in srgb, var(--ground) 70%, transparent)", zIndex: 5 }}>
      <div style={{ width: "min(380px, 100%)", display: "flex", flexDirection: "column", gap: 10, padding: 14, background: "var(--surface)",
        border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: "var(--card-shadow)" }}>
        <Notice message="The map stopped drawing." detail={lost
          ? "The graphics card reset (often when another tab or app uses it heavily). Restart the map to draw it again; the run and your view settings stay."
          : "Something went wrong while drawing the map. Restart it to draw again; the run and your view settings stay."} />
        <div><Button variant="raised" onClick={onRestart} style={{ height: 30, padding: "0 12px", borderRadius: "var(--radius-md)", font: "inherit", fontWeight: 600 }}>Restart map</Button></div>
      </div>
    </div>
  );
}
