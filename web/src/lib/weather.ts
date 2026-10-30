// What the cloud and rain on the map, the label and the "Rain now" panel show at a given model time.
// Derived from the storm's parameters only: the same hyetograph and track the backend uses (lib/rain.ts).
import { useEffect, useState } from "react";
import type { RainField, RunManifest, Storm } from "./api";
import { useClock } from "./clock";
import { useLayers } from "./layers";
import { compassOf, hyetograph, LonLat, metresBetween, offsetLL, peakHours, RainPlace, useRain } from "./rain";
import { SIM_HOURS, sim, useSim } from "./simstate";

type Pattern = NonNullable<Storm["pattern"]>;
type Bounds = [number, number, number, number];
export type WeatherSpec = {
  kind: "cell" | "area" | "whole";
  /** Cell: where it is at peak time. Area: middle of the polygon. Whole: middle of the AOI. */
  centre: LonLat;
  /** Cell radius; for an area or the whole AOI, the reach from the middle to the farthest corner. */
  radiusM: number;
  profile: "gaussian" | "exponential" | "flat";
  track: { heading_deg: number; speed_m_s: number } | null;
  /** Polygon (area) or the AOI box (whole), for sampling. */
  ring: LonLat[] | null;
  /** Place name when the rain area is a named place. */
  place: string | null;
};
export type WeatherNow = {
  /** Where the cloud deck is now. */
  centre: LonLat;
  /** mm/h over the centre (cell) or over the rain area (area, whole). */
  rate: number;
  peak: number; peakT_s: number;
  /** 0..1: the rate against the pattern's peak. */
  strength: number;
  /** 0..1: how much of the deck is left once the storm is over (clouds thin out and drift off). */
  presence: number;
  /** Metres the deck has drifted since the storm ended. */
  drift: number;
  /** Cumulative mm at the centre. */
  fallen: number;
  /** Mean rate over the whole AOI, mm/h. */
  areaRate: number;
};

const ringOfBounds = (b: Bounds): LonLat[] => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
const mid = (ring: LonLat[]): LonLat => {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};
const reach = (c: LonLat, ring: LonLat[]) => Math.max(...ring.map((p) => metresBetween(c, p).dist));

/** The rain area a storm stands for, with places resolved to their outline. null while nothing is known. */
export function weatherSpec(storm: Storm, places: RainPlace[], bounds: Bounds | null): WeatherSpec | null {
  const sp = storm.spatial ?? null;
  const place = (n: string | null) => (n ? places.find((p) => p.name === n) : undefined);
  if (sp?.kind === "cell") {
    const pl = place(sp.place);
    const centre = sp.center ?? (pl ? ([pl.lon, pl.lat] as LonLat) : bounds ? mid(ringOfBounds(bounds)) : null);
    if (!centre) return null;
    return { kind: "cell", centre, radiusM: sp.radius_m, profile: sp.profile, track: sp.track, ring: null, place: sp.place };
  }
  if (sp?.kind === "polygon") {
    const pl = place(sp.place);
    const ring = sp.polygon ?? pl?.ring ?? null;
    if (ring && ring.length >= 3) {
      const c = mid(ring);
      return { kind: "area", centre: c, radiusM: reach(c, ring), profile: "flat", track: null, ring, place: sp.place };
    }
  }
  if (!bounds) return null;
  const ring = ringOfBounds(bounds), c = mid(ring);
  return { kind: "whole", centre: c, radiusM: reach(c, ring), profile: "flat", track: null, ring, place: null };
}

/** Linear interpolation of the hyetograph (samples spread over the storm) at t hours; 0 outside the storm. */
function rateAt(series: number[], duration_h: number, t_h: number): number {
  if (t_h < 0 || t_h > duration_h) return 0;
  const x = (t_h / duration_h) * (series.length - 1), i = Math.min(series.length - 2, Math.floor(x)), f = x - i;
  return Math.max(0, series[i] * (1 - f) + series[i + 1] * f);
}
function fallenAt(series: number[], duration_h: number, t_h: number): number {
  const T = Math.min(Math.max(t_h, 0), duration_h), n = series.length - 1, dt = duration_h / n;
  let sum = 0;
  for (let i = 0; i < n && i * dt < T; i++) {
    const a = i * dt, b = Math.min((i + 1) * dt, T);
    sum += ((rateAt(series, duration_h, a) + rateAt(series, duration_h, b)) / 2) * (b - a);
  }
  return sum;
}

/** Share of a moving cell's disc that is over the AOI box, by a coarse grid. */
function insideShare(c: LonLat, radiusM: number, b: Bounds): number {
  let inside = 0, all = 0;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    if (i * i + j * j > 5) continue;
    const p = offsetLL(c, (i / 2) * radiusM, (j / 2) * radiusM);
    all++;
    if (p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]) inside++;
  }
  return all ? inside / all : 0;
}

export const THIN_H = 0.5; // clouds thin out and drift off over the half hour after the rain stops
const DRIFT_M_S = 6;

export function weatherAt(storm: Storm, spec: WeatherSpec, t_s: number, preview: RainField | null, bounds: Bounds | null): WeatherNow {
  const pattern: Pattern = storm.pattern ?? "uniform";
  const series = hyetograph(storm.total_mm, storm.duration_h, pattern);
  const t_h = t_s / 3600, peak = Math.max(...series), pk = peakHours(storm.duration_h, pattern);
  const rate = rateAt(series, storm.duration_h, t_h);
  const after = Math.max(0, t_h - storm.duration_h);
  let centre = spec.centre;
  if (spec.track) {
    const h = (spec.track.heading_deg * Math.PI) / 180, d = spec.track.speed_m_s * (t_h - pk) * 3600;
    centre = offsetLL(spec.centre, d * Math.sin(h), d * Math.cos(h));
  }
  // Area mean from the preview's mean / max proportion; a moving cell only rains on the AOI while it is over it.
  const share = preview && preview.max_point_mm > 0 ? Math.min(1, preview.mean_aoi_mm / preview.max_point_mm) : spec.kind === "cell" ? 0.25 : 1;
  const areaRate = spec.kind === "whole" ? rate : rate * share * (spec.track && bounds ? insideShare(centre, spec.radiusM, bounds) : 1);
  return {
    centre, rate, peak, peakT_s: pk * 3600, strength: peak > 0 ? Math.min(1, rate / peak) : 0,
    presence: Math.max(0, 1 - after / THIN_H), drift: after * 3600 * DRIFT_M_S,
    fallen: fallenAt(series, storm.duration_h, t_h), areaRate,
  };
}

/** Model time the weather shows: the server's if reported, else elapsed / estimated run time over the model hours. */
export function liveModelT(s = sim.get(), now = Date.now()): number {
  if (s.modelT != null) return s.modelT;
  if (s.progress != null) return s.progress * SIM_HOURS * 3600;
  const frac = s.startedAt != null ? (now - s.startedAt) / 1000 / (s.estS || 40) : 0;
  return Math.min(0.98, Math.max(0, frac)) * SIM_HOURS * 3600;
}

export type WeatherSource = { storm: Storm; live: boolean } | null;
/** What weather to show: the running Simulate's storm, else the finished run's while "Clouds and rain" is on. */
export function useWeatherSource(run?: RunManifest): WeatherSource {
  const s = useSim(), lay = useLayers();
  if (s.running && s.storm) return { storm: s.storm, live: true };
  if (lay.weather.on && run?.status === "done") return { storm: run.scenario.storm, live: false };
  return null;
}

/** The weather now, refreshed about 5 times a second while live and with the clock in playback. */
export function useWeatherNow(src: WeatherSource): { spec: WeatherSpec; now: WeatherNow; t_s: number } | null {
  const r = useRain(), clk = useClock();
  const [, tick] = useState(0);
  const live = !!src?.live;
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => tick((n) => n + 1), 200);
    return () => window.clearInterval(id);
  }, [live]);
  if (!src) return null;
  const spec = weatherSpec(src.storm, r.places, r.bounds);
  if (!spec) return null;
  const t_s = src.live ? liveModelT() : clk.t_s;
  return { spec, t_s, now: weatherAt(src.storm, spec, t_s, r.preview, r.bounds) };
}

/** "Storm cell · 38 mm/h now" and its second line. */
export function weatherLabel(spec: WeatherSpec, now: WeatherNow, fmtT: (s: number) => string): { title: string; sub: string | null } {
  const mm = `${Math.round(now.rate)} mm/h now`;
  if (spec.kind === "cell") {
    const mv = spec.track ? ` · moving ${compassOf(spec.track.heading_deg)} ${+spec.track.speed_m_s.toFixed(1)} m/s` : "";
    return { title: `Storm cell · ${mm}`, sub: `peak at ${fmtT(now.peakT_s)}${mv}` };
  }
  if (spec.kind === "area") return { title: `Rain${spec.place ? ` over ${spec.place}` : ""} · ${mm}`, sub: `peak at ${fmtT(now.peakT_s)}` };
  return { title: `Rain · ${mm}`, sub: null };
}
