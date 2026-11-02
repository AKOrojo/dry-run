// An overlay element that follows a lon/lat on the globe every frame (updated from the scene's postRender).
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import * as Cesium from "cesium";

export type Anchors = Set<(scene: Cesium.Scene) => void>;

export function Anchored({ anchors, scene, lon, lat, dx = 0, dy = 0, clamp, children }: {
  anchors: React.MutableRefObject<Anchors>; scene?: Cesium.Scene; lon: number; lat: number; dx?: number; dy?: number;
  /** Keep the element on the map when its point is off screen: margins in px from each edge (left, top, right, bottom). */
  clamp?: [number, number, number, number]; children: ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scene) return;
    const scratch = new Cesium.Cartesian2();
    const update = (s: Cesium.Scene) => {
      const node = el.current;
      if (!node || s.isDestroyed()) return;
      const h = s.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat)) ?? 0;
      const win = Cesium.SceneTransforms.worldToWindowCoordinates(s, Cesium.Cartesian3.fromDegrees(lon, lat, h), scratch);
      const w = s.canvas.clientWidth, hh = s.canvas.clientHeight;
      if (!win && !clamp) { node.style.display = "none"; return; }
      if (clamp) {
        // Behind the camera there is no window point: pin to the bottom edge, roughly below the point.
        const x = win ? win.x + dx : w / 2, y = win ? win.y + dy : hh;
        node.style.display = "";
        node.style.transform = `translate(${Math.round(Math.min(w - clamp[2], Math.max(clamp[0], x)))}px, ${Math.round(Math.min(hh - clamp[3], Math.max(clamp[1], y)))}px)`;
        return;
      }
      if (!win || win.x < -80 || win.y < -80 || win.x > w + 80 || win.y > hh + 80) { node.style.display = "none"; return; }
      node.style.display = "";
      node.style.transform = `translate(${Math.round(win.x + dx)}px, ${Math.round(win.y + dy)}px)`;
    };
    anchors.current.add(update);
    update(scene);
    return () => { anchors.current.delete(update); };
  }, [scene, lon, lat, dx, dy, anchors, clamp?.join(",")]);  // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={el} data-anchored="" style={{ position: "absolute", left: 0, top: 0, display: "none", pointerEvents: "none", willChange: "transform" }}>{children}</div>;
}

