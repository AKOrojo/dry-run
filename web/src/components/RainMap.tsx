// The rain area on the map: preview of the rain field, the storm cell's centre / ring / track, the drawn
// polygon, and the interactions that edit them. User-set things are danfo; the preview image is already --depth-3.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as RPointerEvent } from "react";
import * as Cesium from "cesium";
import { Anchored } from "./Anchored";
import type { Anchors } from "./Anchored";
import { compassOf, effectiveCentre, isCell, metresBetween, offsetLL, rain, setRain, trackEnds, useRain } from "../lib/rain";
import type { LonLat } from "../lib/rain";
import type { Storm } from "../lib/api";
import { sim } from "../lib/simstate";

const cssColor = (name: string) => Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
const card: CSSProperties = {
  display: "flex", flexDirection: "column", padding: "4px 9px 5px", background: "color-mix(in srgb, var(--ground) 84%, transparent)", backdropFilter: "blur(6px)",
  border: "1px solid color-mix(in srgb, var(--ink) 10%, transparent)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", whiteSpace: "nowrap",
};
const FIG: CSSProperties = { fontVariantNumeric: "tabular-nums" };

function ringPts(c: LonLat, r: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * 2 * Math.PI;
    const p = offsetLL(c, r * Math.cos(a), r * Math.sin(a));
    out.push(p[0], p[1]);
  }
  return out;
}

type Held = { remove: () => void; setOpacity: (a: number) => void; prim?: Cesium.GroundPrimitive };

export function RainMap({ viewer, scene, anchors, basemap, opacity, hasRun, storm }: {
  viewer?: Cesium.Viewer; scene?: Cesium.Scene; anchors: React.MutableRefObject<Anchors>; basemap: "aerial" | "photoreal"; opacity: number; hasRun: boolean;
  storm: Pick<Storm, "total_mm" | "duration_h" | "pattern">;
}) {
  const s = useRain();
  const preview = s.preview;
  const centre = effectiveCentre(s);
  const cell = isCell(s) && !!centre;
  const alive = !!viewer && !viewer.isDestroyed();
  const bounds = s.bounds;
  const sizeM = bounds ? Math.max(metresBetween([bounds[0], bounds[1]], [bounds[2], bounds[1]]).dist, metresBetween([bounds[0], bounds[1]], [bounds[0], bounds[3]]).dist) : 10000;
  const pattern = storm.pattern ?? "uniform";

  // ----- the preview image: an imagery layer on Aerial, a textured ground primitive classifying the 3D tiles on Photoreal -----
  const held = useRef<Held & { kind: string }>();
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;
  const png = s.visible ? preview?.png : undefined;
  const rectKey = preview?.bounds_wgs84.join(",");
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    if (!png || !preview) { held.current?.remove(); held.current = undefined; return; }
    let cancelled = false;
    const rect = Cesium.Rectangle.fromDegrees(...preview.bounds_wgs84);
    const swap = (next: Held & { kind: string }) => {
      if (cancelled || viewer.isDestroyed()) { next.remove(); return; }
      if (held.current && held.current !== next) held.current.remove();
      held.current = next;
      next.setOpacity(opacityRef.current);
    };
    if (basemap === "aerial") {
      Cesium.SingleTileImageryProvider.fromUrl(png, { rectangle: rect }).then((p) => {
        if (cancelled || viewer.isDestroyed()) return;
        const layer = viewer.imageryLayers.addImageryProvider(p);
        swap({ kind: "imagery", remove: () => { if (!viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true); }, setOpacity: (a) => { layer.alpha = a; } });
      }).catch(() => { /* image not usable: keep the last preview */ });
    } else if (held.current?.kind === "drape" && held.current.prim && !held.current.prim.isDestroyed()) {
      (held.current.prim.appearance as Cesium.MaterialAppearance).material.uniforms.image = png;
    } else {
      const prim = new Cesium.GroundPrimitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.RectangleGeometry({ rectangle: rect, vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat }) }),
        appearance: new Cesium.MaterialAppearance({ material: Cesium.Material.fromType("Image", { image: png, color: Cesium.Color.WHITE }), flat: true, translucent: true }),
        classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
      });
      viewer.scene.groundPrimitives.add(prim);
      swap({ kind: "drape", prim, remove: () => { if (!viewer.isDestroyed() && !prim.isDestroyed()) viewer.scene.groundPrimitives.remove(prim); },
        setOpacity: (a) => { if (!prim.isDestroyed()) (prim.appearance as Cesium.MaterialAppearance).material.uniforms.color = new Cesium.Color(1, 1, 1, a); } });
    }
    return () => { cancelled = true; };
  }, [viewer, png, basemap, rectKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { held.current?.setOpacity(opacity); }, [opacity]);
  useEffect(() => () => { held.current?.remove(); held.current = undefined; }, [viewer]);
  // The basemap switched kind: drop the other kind's image so only the right one is built.
  useEffect(() => {
    const want = basemap === "aerial" ? "imagery" : "drape";
    if (held.current && held.current.kind !== want && !png) { held.current.remove(); held.current = undefined; }
  }, [basemap, png]);

  // ----- outlines: ring (dashed), track, drawn polygon, place outline -----
  const [draft, setDraft] = useState<LonLat[]>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const track = useMemo(() => {
    if (!cell || !centre || !s.moving) return null;
    return trackEnds(centre, s.heading_deg, s.speed_m_s, storm.duration_h, pattern, sizeM);
  }, [cell, centre?.[0], centre?.[1], s.moving, s.heading_deg, s.speed_m_s, storm.duration_h, pattern, sizeM]);
  const place = s.mode === "place" && !s.placeAsCell ? s.places.find((p) => p.name === s.place) : undefined;
  const shown = s.visible;
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const danfo = cssColor("--danfo"), ground = cssColor("--ground");
    const made: Cesium.Entity[] = [];
    const line = (flat: number[], dashed: boolean, width = 3) => made.push(viewer.entities.add({ polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(flat), width, clampToGround: true,
      material: dashed ? new Cesium.PolylineDashMaterialProperty({ color: danfo, dashLength: 18 }) : danfo } }));
    const dot = (p: LonLat) => made.push(viewer.entities.add({ position: Cesium.Cartesian3.fromDegrees(p[0], p[1]),
      point: { pixelSize: 7, color: danfo, outlineColor: ground, outlineWidth: 2, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
    if (s.picking === "polygon") {
      if (draft.length >= 2) line(draft.flat(), false);
      draft.forEach(dot);
    } else if (shown) {
      if (cell && centre) line(ringPts(centre, s.radius_m), true, 2);
      if (track) line([...track.start, ...track.end], true, 3);
      if (s.mode === "draw" && s.polygon) line([...s.polygon, s.polygon[0]].flat(), false);
      if (place) line([...place.ring, place.ring[0]].flat(), false);
    }
    return () => { if (!viewer.isDestroyed()) made.forEach((e) => viewer.entities.remove(e)); };
  }, [viewer, shown, s.picking, draft, cell, centre?.[0], centre?.[1], s.radius_m, track, s.mode, s.polygon, place]);

  // ----- frame the rain area when it is chosen (mode, place or a finished drawing), not while dragging -----
  const frameKey = s.picking ? null : `${s.mode}|${s.place}|${s.placeAsCell}|${s.polygon?.length ?? 0}|${s.moving}|${centre ? "c" : ""}`;
  const framed = useRef<string | null>(null);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !frameKey || frameKey === framed.current || s.mode === "whole") return;
    const pts: LonLat[] = [];
    if (cell && centre) {
      pts.push(offsetLL(centre, -s.radius_m, -s.radius_m), offsetLL(centre, s.radius_m, s.radius_m));
      if (track) pts.push(track.start, track.end);
    } else if (s.mode === "draw" && s.polygon) pts.push(...s.polygon);
    else if (place) pts.push(...place.ring);
    if (!pts.length) return;
    framed.current = frameKey;
    const sphere = Cesium.BoundingSphere.fromPoints(pts.map((p) => Cesium.Cartesian3.fromDegrees(p[0], p[1])));
    viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.2, offset: new Cesium.HeadingPitchRange(viewer.camera.heading, Math.min(viewer.camera.pitch, Cesium.Math.toRadians(-45)), sphere.radius * 2.6),
    });
  }, [viewer, frameKey, cell, centre?.[0], centre?.[1], track, place, s.polygon]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- map clicks: place the centre, or add polygon vertices -----
  const finish = (pts: LonLat[]) => {
    if (pts.length >= 3) setRain({ polygon: pts, picking: null });
    else setRain({ picking: null });
    setDraft([]);
  };
  useEffect(() => { if (s.picking !== "polygon") setDraft([]); }, [s.picking]);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const canvas = viewer.canvas, sc = viewer.scene;
    let down: { x: number; y: number } | null = null;
    const local = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const pick = (x: number, y: number): LonLat | null => {
      const p = sc.globe.pick(viewer.camera.getPickRay(new Cesium.Cartesian2(x, y)) as Cesium.Ray, sc);
      if (!p) return null;
      const c = Cesium.Cartographic.fromCartesian(p);
      return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
    };
    const onDown = (e: PointerEvent) => { down = e.button === 0 ? local(e) : null; };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return;
      const { x, y } = local(e);
      const moved = Math.hypot(x - down.x, y - down.y) > 4;
      down = null;
      if (moved || sim.get().running) return;  // the rain area is locked while a run is going
      const st = rain.get();
      const click = st.picking === "centre" || (st.picking === null && st.mode === "cell" && st.visible && !hasRun);
      if (st.picking !== "polygon" && !click) return;
      const p = pick(x, y);
      if (!p) return;
      if (st.picking === "polygon") setDraft((cur) => [...cur, p]);
      else setRain({ center: clampTo(p, st.bounds), picking: null });
    };
    const onDbl = () => {
      if (rain.get().picking !== "polygon" || sim.get().running) return;
      const cur = draftRef.current;
      finish(cur.length >= 4 ? cur.slice(0, -1) : cur);  // the second click of the double-click added a duplicate vertex
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("dblclick", onDbl);
    return () => { canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("dblclick", onDbl); };
  }, [viewer, hasRun]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const picking = rain.get().picking;
      if (!picking || sim.get().running) return;
      if (e.key === "Escape") setRain({ picking: null });
      else if (picking === "polygon" && e.key === "Enter") { e.preventDefault(); finish(draftRef.current); }
      else if (picking === "polygon" && e.key === "Backspace") { e.preventDefault(); setDraft((p) => p.slice(0, -1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ----- draggable handles (DOM, so they restyle with the tokens) -----
  const pickAt = (clientX: number, clientY: number): LonLat | null => {
    if (!viewer || viewer.isDestroyed()) return null;
    const r = viewer.canvas.getBoundingClientRect();
    const p = viewer.scene.globe.pick(viewer.camera.getPickRay(new Cesium.Cartesian2(clientX - r.left, clientY - r.top)) as Cesium.Ray, viewer.scene);
    if (!p) return null;
    const c = Cesium.Cartographic.fromCartesian(p);
    return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
  };
  const drag = (e: RPointerEvent<HTMLElement>, onMove: (p: LonLat) => void) => {
    e.stopPropagation(); e.preventDefault();
    if (sim.get().running) return;  // locked while simulating, like the Rain area card
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { const p = pickAt(ev.clientX, ev.clientY); if (p) onMove(p); };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  };
  const moveCentre = (p: LonLat) => setRain({ mode: "cell", place: s.mode === "place" ? s.place : null, center: clampTo(p, bounds) });
  const resize = (p: LonLat) => { if (centre) setRain({ radius_m: Math.round(Math.min(15000, Math.max(1000, metresBetween(centre, p).dist)) / 100) * 100 }); };
  const steer = (p: LonLat) => {
    if (!centre) return;
    const m = metresBetween(centre, p);
    if (m.dist < 50) return;
    const heading = ((Math.atan2(m.east, m.north) * 180) / Math.PI + 360) % 360;
    const reach = Math.abs(storm.duration_h - (pattern === "front_loaded" ? 0 : storm.duration_h / 2)) * 3600;
    // The tip is where the cell is at the end of the storm, so its distance is the speed unless the line is clipped.
    const speed = m.dist < sizeM && reach > 0 ? Math.round(Math.min(20, m.dist / reach) * 10) / 10 : rain.get().speed_m_s;
    setRain({ heading_deg: Math.round(heading), speed_m_s: speed });
  };

  if (!alive || !scene) return null;
  const rainShown = s.visible && (cell || s.mode !== "whole");
  const peakNote = "the storm passes over this point at its peak";
  return (
    <>
      {rainShown && cell && centre && (
        <>
          <Anchored anchors={anchors} scene={scene} lon={centre[0]} lat={centre[1]} dy={-34}>
            <span style={{ ...card, transform: "translate(-50%, -100%)", position: "absolute", left: 0, top: 0, ...FIG }}>
              <span style={{ fontSize: 12, lineHeight: "16px", fontWeight: 600 }}>Storm cell</span>
              <span style={{ color: "var(--ink-muted)", fontSize: 11, lineHeight: "14px" }}>{s.moving ? `${storm.total_mm} mm · ${storm.duration_h} h · at its peak here` : `${storm.total_mm} mm at the centre · ${storm.duration_h} h`}</span>
            </span>
          </Anchored>
          <Anchored anchors={anchors} scene={scene} lon={centre[0]} lat={centre[1]}>
            <button type="button" aria-label="Storm centre: drag to move" title="Drag to move the storm" onPointerDown={(e) => drag(e, moveCentre)}
              style={{ position: "absolute", left: -11, top: -11, width: 22, height: 22, padding: 0, borderRadius: "50%", cursor: "grab", pointerEvents: "auto", touchAction: "none",
                background: "var(--danfo)", border: "3px solid var(--ground)", boxShadow: "0 0 0 2px var(--danfo), var(--shadow-float)" }} />
          </Anchored>
          <RingHandle anchors={anchors} scene={scene} at={offsetLL(centre, s.radius_m, 0)} label={`R ${+(s.radius_m / 1000).toFixed(1)} km`}
            onDown={(e) => drag(e, resize)} />
          {track && (
            <>
              <TipHandle anchors={anchors} scene={scene} at={track.end} heading={s.heading_deg} onDown={(e) => drag(e, steer)} />
              <Anchored anchors={anchors} scene={scene} lon={track.start[0]} lat={track.start[1]} dy={22}>
                <span style={{ ...card, position: "absolute", left: 0, top: 0, transform: "translate(-50%, 0)", fontSize: 12, lineHeight: "16px", ...FIG }}>
                  Moves {compassOf(s.heading_deg)} · {s.speed_m_s} m/s · {peakNote}
                </span>
              </Anchored>
            </>
          )}
        </>
      )}
    </>
  );
}

function clampTo(p: LonLat, b: [number, number, number, number] | null): LonLat {
  return b ? [Math.min(b[2], Math.max(b[0], p[0])), Math.min(b[3], Math.max(b[1], p[1]))] : p;
}

function RingHandle({ anchors, scene, at, label, onDown }: { anchors: React.MutableRefObject<Anchors>; scene: Cesium.Scene; at: LonLat; label: string; onDown: (e: RPointerEvent<HTMLElement>) => void }) {
  return (
    <Anchored anchors={anchors} scene={scene} lon={at[0]} lat={at[1]}>
      <button type="button" aria-label="Storm radius: drag to resize" title="Drag to resize" onPointerDown={onDown}
        style={{ position: "absolute", left: -8, top: -8, width: 16, height: 16, padding: 0, borderRadius: "50%", cursor: "ew-resize", pointerEvents: "auto", touchAction: "none",
          background: "var(--ground)", border: "2px solid var(--danfo)", boxShadow: "var(--shadow-float)" }} />
      <span style={{ ...card, position: "absolute", left: 14, top: 10, fontSize: 11, lineHeight: "14px", fontWeight: 600, ...FIG }}>{label}</span>
    </Anchored>
  );
}

/** Arrowhead at the end of the track, turned to the on-screen direction of travel; dragging it steers. */
function TipHandle({ anchors, scene, at, heading, onDown }: { anchors: React.MutableRefObject<Anchors>; scene: Cesium.Scene; at: LonLat; heading: number; onDown: (e: RPointerEvent<HTMLElement>) => void }) {
  const el = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const a = new Cesium.Cartesian2(), b = new Cesium.Cartesian2();
    const h = (heading * Math.PI) / 180;
    const update = (sc: Cesium.Scene) => {
      const node = el.current;
      if (!node || sc.isDestroyed()) return;
      const ground = (p: LonLat) => Cesium.Cartesian3.fromDegrees(p[0], p[1], sc.globe.getHeight(Cesium.Cartographic.fromDegrees(p[0], p[1])) ?? 0);
      const wa = Cesium.SceneTransforms.worldToWindowCoordinates(sc, ground(at), a);
      const ahead = offsetLL(at, 40 * Math.sin(h), 40 * Math.cos(h));
      const wb = Cesium.SceneTransforms.worldToWindowCoordinates(sc, ground(ahead), b);
      if (!wa || !wb || wa.x < -80 || wa.y < -80 || wa.x > sc.canvas.clientWidth + 80 || wa.y > sc.canvas.clientHeight + 80) { node.style.display = "none"; return; }
      node.style.display = "";
      const ang = (Math.atan2(wb.x - wa.x, -(wb.y - wa.y)) * 180) / Math.PI;
      node.style.transform = `translate(${Math.round(wa.x)}px, ${Math.round(wa.y)}px) translate(-50%, -50%) rotate(${ang}deg)`;
    };
    anchors.current.add(update);
    update(scene);
    return () => { anchors.current.delete(update); };
  }, [scene, anchors, at[0], at[1], heading]);
  return (
    <button ref={el} type="button" aria-label="Storm heading: drag to steer" title="Drag to steer" onPointerDown={onDown}
      style={{ position: "absolute", left: 0, top: 0, width: 26, height: 26, padding: 0, background: "transparent", border: 0, cursor: "grab", pointerEvents: "auto", touchAction: "none", willChange: "transform" }}>
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" style={{ display: "block", filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.5))" }}>
        <path d="M13 2 L22 22 L13 17 L4 22 Z" fill="var(--danfo)" stroke="var(--ground)" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
