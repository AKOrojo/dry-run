// THE one clock (FireTrace pattern): map frames, charts, route and event markers all
// read `t_s` from here. Nothing else keeps its own time. (owner: Eng B)
import { useSyncExternalStore } from "react";

type State = { t_s: number; playing: boolean; speed: number; max_s: number };
let state: State = { t_s: 0, playing: false, speed: 600, max_s: 6 * 3600 }; // speed = sim seconds per real second
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const clock = {
  get: () => state,
  set: (p: Partial<State>) => { state = { ...state, ...p, t_s: Math.max(0, Math.min(p.t_s ?? state.t_s, p.max_s ?? state.max_s)) }; emit(); },
  subscribe: (f: () => void) => { subs.add(f); return () => subs.delete(f); },
};

let last = performance.now();
function tick(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  if (state.playing) {
    const t = state.t_s + dt * state.speed;
    clock.set(t >= state.max_s ? { t_s: state.max_s, playing: false } : { t_s: t });
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

export const useClock = () => useSyncExternalStore(clock.subscribe, clock.get);
