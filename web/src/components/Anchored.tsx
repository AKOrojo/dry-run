// An overlay element that follows a lon/lat on the globe every frame (updated from the scene's postRender).
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import * as Cesium from "cesium";

export type Anchors = Set<(scene: Cesium.Scene) => void>;

export function Anchored({ anchors, scene, lon, lat, dx = 0, dy = 0, children }: {
  anchors: React.MutableRefObject<Anchors>; scene?: Cesium.Scene; lon: number; lat: number; dx?: number; dy?: number; children: ReactNode;
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
      if (!win || win.x < -80 || win.y < -80 || win.x > w + 80 || win.y > hh + 80) { node.style.display = "none"; return; }
      node.style.display = "";
      node.style.transform = `translate(${Math.round(win.x + dx)}px, ${Math.round(win.y + dy)}px)`;
    };
    anchors.current.add(update);
    update(scene);
    return () => { anchors.current.delete(update); };
  }, [scene, lon, lat, dx, dy, anchors]);
  return <div ref={el} style={{ position: "absolute", left: 0, top: 0, display: "none", pointerEvents: "none", willChange: "transform" }}>{children}</div>;
}

