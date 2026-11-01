// The globes render on demand (requestRenderMode): an idle map draws nothing. Cesium renders by itself when the camera
// moves or tiles load; this module asks for frames when our own state changes (clock, layers, primitives added or
// removed), and keeps frames coming while something animates (holdRendering) or a camera mode moves (holdWhileMoving).
import * as Cesium from "cesium";
import { clock } from "./clock";
import { layers } from "./layers";
import { rain } from "./rain";
import { sim } from "./simstate";

const scenes = new Set<Cesium.Scene>();
let pending = 0;
let holders = 0;
let raf = 0;

const renderAll = () => scenes.forEach((s) => { if (!s.isDestroyed()) s.requestRender(); });

/** Render now and on the next two frames: React applies a state change in effects that may land a frame later. */
export function requestRenderSoon() {
  renderAll();
  if (pending) return;
  pending = requestAnimationFrame(() => { renderAll(); pending = requestAnimationFrame(() => { pending = 0; renderAll(); }); });
}

/** Render every frame until the returned release is called (an animation, e.g. clouds and rain). */
export function holdRendering(): () => void {
  holders++;
  const loop = () => { raf = 0; if (holders <= 0) return; renderAll(); raf = requestAnimationFrame(loop); };
  if (!raf) raf = requestAnimationFrame(loop);
  let released = false;
  return () => { if (!released) { released = true; holders--; } };
}

/** Frames for a mode that moves the camera from preRender (which runs only on drawn frames): poke() when input may
 *  start a move; frames then keep coming while busy() holds or the camera still moved in the last frame (easing). */
export function holdWhileMoving(scene: Cesium.Scene, busy: () => boolean): { poke: () => void; stop: () => void } {
  const cam = scene.camera;
  let raf = 0, pos = new Cesium.Cartesian3(), dir = new Cesium.Cartesian3();
  const tick = () => {
    raf = 0;
    if (scene.isDestroyed()) return;
    const moved = !Cesium.Cartesian3.equalsEpsilon(cam.positionWC, pos, 0, 0.01) || !Cesium.Cartesian3.equalsEpsilon(cam.directionWC, dir, 1e-5);
    pos = Cesium.Cartesian3.clone(cam.positionWC, pos);
    dir = Cesium.Cartesian3.clone(cam.directionWC, dir);
    if (!moved && !busy()) return;
    scene.requestRender();
    raf = requestAnimationFrame(tick);
  };
  return {
    poke: () => {
      if (raf || scene.isDestroyed()) return;
      scene.requestRender();
      pos = new Cesium.Cartesian3(NaN, NaN, NaN);  // counts as moved: the first frame always runs
      raf = requestAnimationFrame(tick);
    },
    stop: () => { cancelAnimationFrame(raf); raf = 0; },
  };
}

/** Put a scene on demand rendering: adding or removing a primitive or an imagery layer asks for a frame. */
export function registerScene(s: Cesium.Scene, imagery: Cesium.ImageryLayerCollection): () => void {
  scenes.add(s);
  for (const c of [s.primitives, s.groundPrimitives]) {
    const add = c.add.bind(c), remove = c.remove.bind(c);
    c.add = ((p: unknown, i?: number) => { s.requestRender(); return add(p, i); }) as typeof c.add;
    c.remove = ((p: unknown) => { s.requestRender(); return remove(p); }) as typeof c.remove;
  }
  const req = () => { if (!s.isDestroyed()) s.requestRender(); };
  const offs = [imagery.layerAdded.addEventListener(req), imagery.layerRemoved.addEventListener(req), imagery.layerMoved.addEventListener(req),
    imagery.layerShownOrHidden.addEventListener(req)];
  return () => { scenes.delete(s); offs.forEach((off) => off()); };
}

/** Calls start when the camera starts moving and rest once it has held still for restMs. Stillness is polled from the
 *  camera pose: under on-demand rendering moveEnd can arrive late. It counts only from the moment the pointer is up:
 *  Cesium starts inertia on release from the last drag, even after the pointer paused, and a rest counted before the
 *  release would end there and start again. A wheel tick restarts the count too (zoom inertia). */
export function watchMotion(scene: Cesium.Scene, start: () => void, rest: () => void, restMs = 300): () => void {
  const cam = scene.camera, el = scene.canvas;
  let held = 0, stillMs = 0;
  const down = () => { held++; };
  const up = () => { held = Math.max(0, held - 1); stillMs = 0; };
  const wheel = () => { stillMs = 0; };
  el.addEventListener("pointerdown", down);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  el.addEventListener("wheel", wheel, { passive: true });
  const pose = () => ({ pos: Cesium.Cartesian3.clone(cam.positionWC), dir: Cesium.Cartesian3.clone(cam.directionWC) });
  const same = (a: ReturnType<typeof pose>, b: ReturnType<typeof pose>) =>
    Cesium.Cartesian3.equalsEpsilon(a.pos, b.pos, 0, 0.01) && Cesium.Cartesian3.equalsEpsilon(a.dir, b.dir, 1e-7);
  let poll: ReturnType<typeof setInterval> | undefined;
  const off = cam.moveStart.addEventListener(() => {
    if (poll) return;
    start();
    let prev = pose();
    stillMs = 0;
    poll = setInterval(() => {
      if (scene.isDestroyed()) { clearInterval(poll); poll = undefined; return; }
      const now = pose();
      stillMs = same(now, prev) && !held ? stillMs + 100 : 0;
      prev = now;
      if (stillMs < restMs) return;
      clearInterval(poll); poll = undefined;
      rest();
    }, 100);
  });
  return () => {
    off(); clearInterval(poll); poll = undefined;
    el.removeEventListener("pointerdown", down); window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up); el.removeEventListener("wheel", wheel);
  };
}

for (const store of [clock, layers, rain, sim]) store.subscribe(requestRenderSoon);

// Cesium applies an image it fetched for a material (a water drape, a hazard map) in the next frame it renders, but asks
// for no frame when the image arrives: ask for one, or an idle map would keep showing the previous image.
// Safe to remove if Cesium starts requesting a render when a material image loads (checked on 1.146.0).
const fetchImage = Cesium.Resource.prototype.fetchImage;
Cesium.Resource.prototype.fetchImage = function (this: Cesium.Resource, ...args: Parameters<typeof fetchImage>) {
  const p = fetchImage.apply(this, args);
  p?.then(requestRenderSoon, () => {});
  return p;
} as typeof fetchImage;
