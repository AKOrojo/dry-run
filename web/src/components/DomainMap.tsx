// The simulated window of a "rain area only" run: a dashed outline, a dim veil outside it, and a label.
// Hidden when the run has no domain_bbox or the 3D close-up is open (pattern of CloseUp.tsx and RainMap.tsx).
import { useEffect } from "react";
import type { CSSProperties } from "react";
import * as Cesium from "cesium";
import { Anchored } from "./Anchored";
import type { Anchors } from "./Anchored";
import type { RunManifest } from "../lib/api";

type Bbox = [number, number, number, number];
const cssColor = (name: string) => Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
const chip: CSSProperties = {
  position: "absolute", left: 0, top: 0, transform: "translate(-100%, -100%)", padding: "2px 8px", background: "color-mix(in srgb, var(--ground) 84%, transparent)",
  backdropFilter: "blur(6px)", border: "1px solid color-mix(in srgb, var(--ink) 10%, transparent)", borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-float)", whiteSpace: "nowrap", fontSize: 12, lineHeight: "16px", fontWeight: 600,
};

/** The simulated window [w, s, e, n] of a run, or null: whole area, no run, an older run, or a window that grew to
 *  cover the whole area (a wide cell plus its 1 km margin), where an outline would only trace the area's edge. */
export function domainBbox(run?: RunManifest, aoiBounds?: number[]): Bbox | null {
  const b = run?.stats?.domain_bbox as unknown;
  if (!(Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v)))) return null;
  const t = 1e-4;  // about 10 m
  if (aoiBounds?.length === 4 && b[0] <= aoiBounds[0] + t && b[1] <= aoiBounds[1] + t && b[2] >= aoiBounds[2] - t && b[3] >= aoiBounds[3] - t) return null;
  return b as Bbox;
}
/** True when the run simulated only a window and this point lies outside it. */
export function outsideDomain(run: RunManifest | undefined, lon: number, lat: number, aoiBounds?: number[]): boolean {
  const b = domainBbox(run, aoiBounds);
  return !!b && (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]);
}

export function DomainMap({ viewer, scene, anchors, bbox, aoiBounds, basemap, hidden }: {
  viewer?: Cesium.Viewer; scene?: Cesium.Scene; anchors: React.MutableRefObject<Anchors>; bbox: Bbox | null; aoiBounds?: number[]; basemap: "aerial" | "photoreal"; hidden: boolean;
}) {
  const key = bbox?.join(",");
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !bbox || hidden) return;
    const [w, s, e, n] = bbox;
    // The veil covers the model area (everything that could have been simulated), with the simulated window cut out.
    const [W, S, E, N] = aoiBounds?.length === 4 ? aoiBounds : [w - 0.05, s - 0.05, e + 0.05, n + 0.05];
    const outer = Cesium.Cartesian3.fromDegreesArray([W, S, E, S, E, N, W, N]);
    const hole = Cesium.Cartesian3.fromDegreesArray([w, s, w, n, e, n, e, s]);
    const made = [
      viewer.entities.add({ polygon: {
        hierarchy: new Cesium.PolygonHierarchy(outer, [new Cesium.PolygonHierarchy(hole)]), material: cssColor("--ground").withAlpha(0.45),
        classificationType: Cesium.ClassificationType.BOTH,
      } }),
      viewer.entities.add({ polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n, w, s]), width: 2, clampToGround: true,
        classificationType: Cesium.ClassificationType.BOTH, material: new Cesium.PolylineDashMaterialProperty({ color: cssColor("--danfo"), dashLength: 12 }),
      } }),
    ];
    return () => { if (!viewer.isDestroyed()) made.forEach((m) => viewer.entities.remove(m)); };
  }, [viewer, key, aoiBounds?.join(","), basemap, hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!bbox || hidden) return null;
  return (
    <Anchored anchors={anchors} scene={scene} lon={bbox[2]} lat={bbox[3]}>
      <span style={chip} data-declutter={3}>Simulated area</span>
    </Anchored>
  );
}
