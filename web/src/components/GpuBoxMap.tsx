// Map layer of the "3D on your GPU" card: the dashed box outline with its chip, the view-centre feed and the
// "pick the box on the map" click (pattern of CloseUpMap's outlines and chips).
import { useEffect } from "react";
import * as Cesium from "cesium";
import { Crosshair } from "@phosphor-icons/react";
import { Anchored } from "./Anchored";
import type { Anchors } from "./Anchored";
import { abortSolve, boxCentre, setGpuBox, useGpuBox } from "../lib/gpubox";

const M_PER_DEG = 111320;
const cssColor = (name: string) => Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim());

/** [west, south, east, north] of a square box of side size_m around a centre. */
export function boxBounds(c: [number, number], sizeM: number): [number, number, number, number] {
  const dLat = sizeM / 2 / M_PER_DEG, dLon = dLat / Math.cos((c[1] * Math.PI) / 180);
  return [c[0] - dLon, c[1] - dLat, c[0] + dLon, c[1] + dLat];
}

export function GpuBoxMap({ viewer, scene, anchors, hidden, runKey }: {
  viewer?: Cesium.Viewer; scene?: Cesium.Scene; anchors: React.MutableRefObject<Anchors>; hidden: boolean;
  /** The run on the map: when it (or the area) changes, a solve in progress is aborted and the picked centre dropped. */
  runKey?: string;
}) {
  const b = useGpuBox();
  const centre = boxCentre(b);
  useEffect(() => { abortSolve(); setGpuBox({ centre: null, picking: false, error: null }); }, [runKey]);

  // The ground point under the middle of the screen, kept current for the card's default centre.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const s = viewer.scene;
    const update = () => {
      if (viewer.isDestroyed()) return;
      const w = s.canvas.clientWidth, h = s.canvas.clientHeight;
      const p = s.globe.pick(viewer.camera.getPickRay(new Cesium.Cartesian2(w / 2, h / 2)) as Cesium.Ray, s);
      if (!p) return;
      const c = Cesium.Cartographic.fromCartesian(p);
      setGpuBox({ view: [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)] });
    };
    update();
    const off = viewer.camera.moveEnd.addEventListener(update);
    return () => { off(); };
  }, [viewer]);

  // Dashed outline in --danfo, clamped to ground.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || hidden || !b.shown || !centre) return;
    const [w, s, e, n] = boxBounds(centre, b.size_m);
    const ent = viewer.entities.add({ polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n, w, s]), width: 2, clampToGround: true,
      classificationType: Cesium.ClassificationType.BOTH, material: new Cesium.PolylineDashMaterialProperty({ color: cssColor("--danfo"), dashLength: 12 }),
    } });
    return () => { if (!viewer.isDestroyed()) viewer.entities.remove(ent); };
  }, [viewer, hidden, b.shown, centre?.[0], centre?.[1], b.size_m]);

  // Pick: the next left click (not a drag) sets the centre; Esc cancels.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !b.picking) return;
    const canvas = viewer.canvas, s = viewer.scene;
    const prev = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5;
      down = null;
      if (moved) return;
      e.stopImmediatePropagation();
      const r = canvas.getBoundingClientRect();
      const p = s.globe.pick(viewer.camera.getPickRay(new Cesium.Cartesian2(e.clientX - r.left, e.clientY - r.top)) as Cesium.Ray, s);
      if (!p) return;
      const c = Cesium.Cartographic.fromCartesian(p);
      setGpuBox({ centre: [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)], picking: false });
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setGpuBox({ picking: false }); } };
    canvas.addEventListener("pointerdown", onDown, true);
    canvas.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      canvas.removeEventListener("pointerdown", onDown, true);
      canvas.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      if (!viewer.isDestroyed()) canvas.style.cursor = prev;
    };
  }, [viewer, b.picking]);

  const pill = { display: "flex", alignItems: "center", gap: 6, padding: "5px 9px", background: "var(--surface-raised)", border: "1px solid var(--hairline)",
    borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", color: "var(--ink)", fontSize: 12, whiteSpace: "nowrap" } as const;
  const bb = centre ? boxBounds(centre, b.size_m) : null;
  return (
    <>
      {b.shown && !hidden && bb && (
        <Anchored anchors={anchors} scene={scene} lon={bb[2]} lat={bb[3]} dx={10} dy={-14}>
          <div style={{ ...pill, fontWeight: 600 }} data-declutter-phone={2}>GPU 3D box · {b.size_m} m</div>
        </Anchored>
      )}
      {b.picking && (
        <span data-declutter-block style={{ ...pill, position: "absolute", left: "50%", top: 62, transform: "translateX(-50%)", maxWidth: "calc(100% - 32px)", pointerEvents: "none" }}>
          <Crosshair size={14} weight="bold" aria-hidden="true" />Click the map to place the 3D box · Esc to cancel
        </span>
      )}
    </>
  );
}
