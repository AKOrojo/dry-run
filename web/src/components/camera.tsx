// Camera modes beyond Cesium's orbit controller: first-person free flight and fly-along on a drawn route.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Cesium from "cesium";
import type { LonLat } from "../lib/flyroute";
import { holdWhileMoving } from "../lib/render";

const R = 6378137;
const rad = Cesium.Math.toRadians;
const clamp = Cesium.Math.clamp;

export const FREE_MIN_AGL = 20;
export const FREE_MAX_H = 8000;
export const FLY_MIN_AGL = 300;
export const FLY_MAX_AGL = 3000;
const PITCH_MIN = rad(-90), PITCH_MAX = rad(10);
const FLY_PITCH = rad(-25);
const FLY_PITCH_LO = PITCH_MIN - FLY_PITCH, FLY_PITCH_HI = PITCH_MAX - FLY_PITCH;
const SNAP_M = 0.01, SNAP_RAD = rad(0.01);

const isTyping = (t: EventTarget | null) => {
  const n = t as HTMLElement | null;
  return !!n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT" || n.isContentEditable);
};
const groundAt = (s: Cesium.Scene, lonRad: number, latRad: number) => s.globe.getHeight(new Cesium.Cartographic(lonRad, latRad)) ?? undefined;

/** Turn off Cesium's own mouse/touch camera inputs while a custom mode is active; restore on exit. */
function useControllerLock(viewer: Cesium.Viewer | undefined, active: boolean) {
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !active) return;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    return () => { if (!viewer.isDestroyed()) viewer.scene.screenSpaceCameraController.enableInputs = true; };
  }, [viewer, active]);
}

/** Left-drag on the canvas reports pixel deltas (mouse-look). */
function useLookDrag(viewer: Cesium.Viewer | undefined, active: boolean, onLook: (dx: number, dy: number) => void) {
  const cb = useRef(onLook);
  cb.current = onLook;
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !active) return;
    const el = viewer.canvas;
    let last: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => { if (e.button !== 0) return; last = { x: e.clientX, y: e.clientY }; try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ } };
    const move = (e: PointerEvent) => { if (!last) return; cb.current(e.clientX - last.x, e.clientY - last.y); last = { x: e.clientX, y: e.clientY }; };
    const up = (e: PointerEvent) => { last = null; try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
    };
  }, [viewer, active]);
}

/** Held-key set, cleared on blur or when the mode ends; onDown hears each handled key press. */
function useHeldKeys(active: boolean, handled: ReadonlySet<string>, onDown?: () => void) {
  const keys = useRef(new Set<string>());
  const cb = useRef(onDown);
  cb.current = onDown;
  useEffect(() => {
    if (!active) return;
    const set = keys.current;
    const name = (e: KeyboardEvent) => (e.key === " " ? "space" : e.key.toLowerCase());
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = name(e);
      set.add(k);
      if (e.shiftKey) set.add("shift");
      if (handled.has(k)) { e.preventDefault(); cb.current?.(); }
    };
    const up = (e: KeyboardEvent) => { set.delete(name(e)); if (!e.shiftKey) set.delete("shift"); };
    const clear = () => set.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", clear); set.clear(); };
  }, [active, handled]);
  return keys;
}

const FREE_KEYS = new Set(["w", "a", "s", "d", "e", "q", "c", "space"]);
const FLY_KEYS = new Set(["e", "q"]);
const holding = (keys: Set<string>, handled: ReadonlySet<string>) => [...keys].some((k) => handled.has(k));

/** First-person flight: left-drag looks, WASD moves along the heading, E/Space up, Q/C down, Shift 4x, scroll sets speed. */
export function useFreeCamera(viewer: Cesium.Viewer | undefined, active: boolean, onSpeed: (mul: number) => void) {
  const mul = useRef(1);
  const hold = useRef<ReturnType<typeof holdWhileMoving> | null>(null);
  const keys = useHeldKeys(active, FREE_KEYS, () => hold.current?.poke());
  useControllerLock(viewer, active);
  useEffect(() => { if (active) { mul.current = 1; onSpeed(1); } }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  useLookDrag(viewer, active, (dx, dy) => {
    if (!viewer || viewer.isDestroyed()) return;
    const c = viewer.camera;
    c.setView({ orientation: { heading: c.heading + dx * 0.004, pitch: clamp(c.pitch - dy * 0.004, PITCH_MIN, PITCH_MAX), roll: 0 } });
  });

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !active) return;
    const el = viewer.canvas, s = viewer.scene;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      mul.current = clamp(mul.current * (e.deltaY < 0 ? 1.25 : 0.8), 0.05, 20);
      onSpeed(mul.current);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    let last = performance.now();
    const pre = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const k = keys.current;
      const fwd = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0);
      const right = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
      const up = (k.has("e") || k.has("space") ? 1 : 0) - (k.has("q") || k.has("c") ? 1 : 0);
      if (!fwd && !right && !up) return;
      const c = viewer.camera;
      const carto = Cesium.Cartographic.fromCartesian(c.positionWC);
      const g = groundAt(s, carto.longitude, carto.latitude) ?? 0;
      const agl = clamp(carto.height - g, FREE_MIN_AGL, FREE_MAX_H);
      const spd = agl * 0.8 * mul.current * (k.has("shift") ? 4 : 1);
      const h = c.heading;
      const dE = (Math.sin(h) * fwd + Math.cos(h) * right) * spd * dt;
      const dN = (Math.cos(h) * fwd - Math.sin(h) * right) * spd * dt;
      const lon = carto.longitude + dE / (R * Math.cos(carto.latitude));
      const lat = carto.latitude + dN / R;
      const g2 = groundAt(s, lon, lat) ?? g;
      const height = Math.min(FREE_MAX_H, Math.max(g2 + FREE_MIN_AGL, carto.height + up * spd * dt));
      c.setView({ destination: Cesium.Cartesian3.fromRadians(lon, lat, height), orientation: { heading: h, pitch: c.pitch, roll: 0 } });
    };
    s.preRender.addEventListener(pre);
    // Held keys move the camera from preRender: frames run while one is down, then stop.
    const h = (hold.current = holdWhileMoving(s, () => holding(keys.current, FREE_KEYS)));
    return () => { h.stop(); hold.current = null; el.removeEventListener("wheel", wheel); if (!s.isDestroyed()) s.preRender.removeEventListener(pre); };
  }, [viewer, active]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Ground speeds for fly along, metres per second (30 m/s ≈ 110 km/h). */
export const FLY_SPEEDS = [30, 60, 120] as const;
export type FlySpeed = typeof FLY_SPEEDS[number];
export type FlyHud = { s: number; len: number; playing: boolean; speed: FlySpeed; hAgl: number; at: LonLat };

/** Route length in metres along the ground. */
export const routeLength = (r: LonLat[]) => r.slice(1).reduce((m, p, i) => m + segLen(r[i], p), 0);

const segLen = (a: LonLat, b: LonLat) => {
  const lat = rad((a[1] + b[1]) / 2);
  return Math.hypot(rad(b[0] - a[0]) * Math.cos(lat) * R, rad(b[1] - a[1]) * R);
};

/** Travel along a drawn route at a fixed height above ground; drag to look around, scroll or E/Q for height. */
export function useFlyAlong(viewer: Cesium.Viewer | undefined, active: boolean, route: LonLat[]) {
  const path = useMemo(() => {
    const cum = [0];
    for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + segLen(route[i - 1], route[i]));
    return { cum, len: cum[cum.length - 1] ?? 0 };
  }, [route]);
  const st = useRef({ s: 0, playing: false, speed: 60 as FlySpeed, hAgl: FLY_MIN_AGL, yaw: 0, pitch: 0, head: NaN, gS: NaN });
  const [hud, setHud] = useState<FlyHud>({ s: 0, len: path.len, playing: false, speed: 60, hAgl: FLY_MIN_AGL, at: route[0] ?? [0, 0] });
  // A new flight or route starts the HUD at the route's start during render, not in the reset effect below: effects in
  // the same commit (the water below the camera) would otherwise read the last flight's final position.
  const [hudFor, setHudFor] = useState({ active, path });
  if (hudFor.active !== active || hudFor.path !== path) {
    setHudFor({ active, path });
    if (active) setHud((h) => ({ s: 0, len: path.len, playing: false, speed: h.speed, hAgl: FLY_MIN_AGL, at: route[0] ?? [0, 0] }));
  }
  const sync = useCallback(() => {
    const v = st.current;
    setHud({ s: v.s, len: path.len, playing: v.playing, speed: v.speed, hAgl: v.hAgl, at: atRef.current(v.s) });
  }, [path.len]);

  const atRef = useRef<(s: number) => LonLat>(() => route[0] ?? [0, 0]);
  const at = useCallback((s: number): LonLat => {
    const { cum } = path;
    if (route.length < 2) return route[0] ?? [0, 0];
    const d = clamp(s, 0, path.len);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const f = clamp((d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1), 0, 1);
    return [route[i - 1][0] + (route[i][0] - route[i - 1][0]) * f, route[i - 1][1] + (route[i][1] - route[i - 1][1]) * f];
  }, [path, route]);
  atRef.current = at;

  const hold = useRef<ReturnType<typeof holdWhileMoving> | null>(null);
  const poke = () => hold.current?.poke();
  const keys = useHeldKeys(active, FLY_KEYS, poke);
  useControllerLock(viewer, active);

  useEffect(() => {
    if (!active) { st.current.playing = false; return; }
    Object.assign(st.current, { s: 0, playing: false, hAgl: FLY_MIN_AGL, yaw: 0, pitch: 0, head: NaN, gS: NaN });
    sync();
  }, [active, path, sync]);

  useLookDrag(viewer, active, (dx, dy) => {
    const v = st.current;
    v.yaw += dx * 0.004;
    v.pitch = clamp(v.pitch - dy * 0.004, FLY_PITCH_LO, FLY_PITCH_HI);
    poke();
  });

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !active || path.len <= 0) return;
    const el = viewer.canvas, s = viewer.scene;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = st.current;
      v.hAgl = clamp(v.hAgl - e.deltaY * 0.6, FLY_MIN_AGL, FLY_MAX_AGL);
      sync();
      poke();
    };
    el.addEventListener("wheel", wheel, { passive: false });
    let last = performance.now(), lastHud = 0;
    const pre = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const v = st.current;
      const k = keys.current;
      v.hAgl = clamp(v.hAgl + ((k.has("e") ? 1 : 0) - (k.has("q") ? 1 : 0)) * 200 * dt, FLY_MIN_AGL, FLY_MAX_AGL);
      let ended = false;
      if (v.playing) {
        v.s += v.speed * dt;
        if (v.s >= path.len) { v.s = path.len; v.playing = false; ended = true; }
      }
      const p = at(v.s);
      const s0 = Math.min(v.s, Math.max(0, path.len - 60));
      const a = at(s0), b = at(s0 + 60);
      const target = Math.atan2((b[0] - a[0]) * Math.cos(rad(p[1])), b[1] - a[1]);
      // The easings snap once within 0.01° / 1 cm, so a paused flight comes to rest exactly.
      const dh = Cesium.Math.negativePiToPi(target - v.head);
      if (Number.isNaN(v.head) || Math.abs(dh) < SNAP_RAD) v.head = target;
      else v.head += dh * Math.min(1, dt * 2.5);
      const g = groundAt(s, rad(p[0]), rad(p[1]));
      if (g !== undefined) v.gS = Number.isNaN(v.gS) || Math.abs(g - v.gS) < SNAP_M ? g : v.gS + (g - v.gS) * Math.min(1, dt * 3);
      const dest = Cesium.Cartesian3.fromDegrees(p[0], p[1], (Number.isNaN(v.gS) ? 0 : v.gS) + v.hAgl);
      const heading = v.head + v.yaw, pitch = clamp(FLY_PITCH + v.pitch, PITCH_MIN, PITCH_MAX);
      const c = viewer.camera;
      // Setting the same pose again still changes it by float noise, and the on-demand renderer draws on any camera
      // change: a paused flight would keep drawing every frame. Leave the camera alone when nothing moved.
      if (Cesium.Cartesian3.distance(c.positionWC, dest) >= SNAP_M || Math.abs(Cesium.Math.negativePiToPi(c.heading - heading)) >= SNAP_RAD
        || Math.abs(c.pitch - pitch) >= SNAP_RAD) {
        c.setView({ destination: dest, orientation: { heading, pitch, roll: 0 } });
      }
      if (ended || now - lastHud > 100) { lastHud = now; sync(); }
    };
    s.preRender.addEventListener(pre);
    // The flight, held keys and the easing after a turn or a height change move the camera from preRender: frames run
    // while any of them does, then stop.
    const h = (hold.current = holdWhileMoving(s, () => st.current.playing || holding(keys.current, FLY_KEYS)));
    h.poke();
    return () => { h.stop(); hold.current = null; el.removeEventListener("wheel", wheel); if (!s.isDestroyed()) s.preRender.removeEventListener(pre); };
  }, [viewer, active, path, at, sync, keys]);

  return {
    hud,
    /** Start or stop the flight; starting at the end restarts from the beginning. */
    play: (on: boolean) => { const v = st.current; if (on && v.s >= path.len) v.s = 0; v.playing = on && path.len > 0; sync(); poke(); },
    setSpeed: (n: FlySpeed) => { st.current.speed = n; sync(); },
    seek: (s: number) => { st.current.s = clamp(s, 0, path.len); sync(); poke(); },
  };
}
