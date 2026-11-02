// Compare-mode data: per-place stats for two runs, "what changes" from the timeseries, and the
// Difference map (B minus A depth per frame, drawn in the browser from the runs' depth frames).
import { API, RunManifest, runFileUrl } from "./api";
import { areaCache } from "./areaCache";

export type PlaceRow = { place: string; a: number; b: number };

export const isBaseline = (m: RunManifest) => !m.scenario.interventions?.length;
export const sameStorm = (x: RunManifest, y: RunManifest) =>
  JSON.stringify([x.scenario.storm, x.scenario.sim_hours]) === JSON.stringify([y.scenario.storm, y.scenario.sim_hours]);

/** Compare's A and B when the chosen pair is not on offer (runs = this area's, most recent first). The convention holds
 *  everywhere: B is the change, A its baseline (the deltas and the Difference map are B minus A). A side the user chose
 *  and still on offer stays, and only the other is filled. With neither chosen, a run on screen that came from elsewhere
 *  (a link, the agent's) takes its slot: B if it has a change, A if it is a baseline. Otherwise B is the latest change. */
export function pickPair(runs: RunManifest[], chosen: { a?: string; b?: string }, shown?: { id: string; fromElsewhere: boolean }): { a?: string; b?: string } {
  const get = (id?: string) => runs.find((r) => r.run_id === id);
  const other = (x: RunManifest) => runs.find((r) => r !== x);
  /** A's partner for a B: its baseline on the same storm. B's partner for an A: the latest change on the same storm. */
  const baselineFor = (x: RunManifest) => runs.find((r) => r !== x && isBaseline(r) && sameStorm(r, x)) ?? other(x);
  const changeFor = (x: RunManifest) => runs.find((r) => r !== x && !isBaseline(r) && sameStorm(r, x)) ?? other(x);
  let a = get(chosen.a), b = get(chosen.b);
  if (a && b && a !== b) return { a: a.run_id, b: b.run_id };
  if (a && b) b = undefined;  // the same run twice: keep A, fill B
  if (a) return { a: a.run_id, b: changeFor(a)?.run_id };
  if (b) return { a: baselineFor(b)?.run_id, b: b.run_id };
  const on = shown?.fromElsewhere ? get(shown.id) : undefined;
  if (on) return isBaseline(on) ? { a: on.run_id, b: changeFor(on)?.run_id } : { a: baselineFor(on)?.run_id, b: on.run_id };
  b = runs.find((r) => !isBaseline(r)) ?? runs[0];
  return { a: b && baselineFor(b)?.run_id, b: b?.run_id };
}

/** Road km impassable (run max) inside every named place, for runs A and B; largest first. */
export async function byPlace(aoiId: string, a: string, b: string): Promise<PlaceRow[]> {
  const fc = await fetch(`${API}/api/aoi/${aoiId}/layer/places`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const names: string[] = (fc?.features ?? []).filter((f: any) => f.geometry?.type === "Polygon").map((f: any) => f.properties.name);
  const area = (run: string, place: string) => fetch(`${API}/api/runs/${run}/area?place=${encodeURIComponent(place)}`)
    .then((r) => (r.ok ? r.json() : null)).then((d) => (typeof d?.road_km_impassable === "number" ? d.road_km_impassable as number : null)).catch(() => null);
  const rows = await Promise.all(names.map(async (place) => ({ place, a: await area(a, place), b: await area(b, place) })));
  return rows.filter((r): r is PlaceRow => r.a != null && r.b != null).sort((x, y) => Math.max(y.a, y.b) - Math.max(x.a, x.b));
}

export type Change = { label: string; a: number | null; b: number | null; kind: "time" | "km2"; note?: string; /** when it happens in B */ tB: number | null };

/** Key moments of each run from its timeseries: first road cut, peak area and time, water left at the end. */
export function whatChanges(a: RunManifest, b: RunManifest): Change[] {
  const firstCut = (m: RunManifest) => { const ts = m.timeseries; if (!ts) return null; const i = ts.edges_cut.findIndex((c) => c > 0); return i < 0 ? null : ts.t_s[i]; };
  const peak = (m: RunManifest) => { const ts = m.timeseries; if (!ts?.flooded_area_km2.length) return null; const v = Math.max(...ts.flooded_area_km2); return { v, t: ts.t_s[ts.flooded_area_km2.indexOf(v)] }; };
  const end = (m: RunManifest) => { const ts = m.timeseries; return ts?.flooded_area_km2.length ? { v: ts.flooded_area_km2[ts.flooded_area_km2.length - 1], t: ts.t_s[ts.t_s.length - 1] } : null; };
  const ca = firstCut(a), cb = firstCut(b), pa = peak(a), pb = peak(b), ea = end(a), eb = end(b);
  const later = ca != null && cb != null && cb !== ca ? `${Math.round(Math.abs(cb - ca) / 60)} min ${cb > ca ? "later" : "earlier"}` : undefined;
  return [
    { label: "First road impassable", a: ca, b: cb, kind: "time", note: cb == null && ca != null ? "no road cut in B" : later, tB: cb },
    { label: "Flooded area at peak", a: pa?.v ?? null, b: pb?.v ?? null, kind: "km2", tB: pb?.t ?? null },
    { label: "Peak arrives", a: pa?.t ?? null, b: pb?.t ?? null, kind: "time", tB: pb?.t ?? null },
    { label: "Still wet at the end", a: ea?.v ?? null, b: eb?.v ?? null, kind: "km2", note: eb ? `at T+${String(Math.floor(eb.t / 3600)).padStart(2, "0")}:${String(Math.floor((eb.t % 3600) / 60)).padStart(2, "0")}` : undefined, tB: eb?.t ?? null },
  ];
}

// ---- Difference map ----
const f16 = (h: number) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  return e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
};
/** A row-major float16/float32 .npy (row 0 = north, as the frame PNGs). */
function parseNpy(buf: ArrayBuffer): { data: Float32Array; ny: number; nx: number } {
  const u8 = new Uint8Array(buf);
  const hlen = u8[8] | (u8[9] << 8);
  const header = new TextDecoder().decode(u8.slice(10, 10 + hlen));
  const [ny, nx] = (header.match(/\((\d+),\s*(\d+)\)/) ?? []).slice(1).map(Number);
  const off = 10 + hlen, n = ny * nx, out = new Float32Array(n);
  if (header.includes("<f2")) { const v = new Uint16Array(buf, off, n); for (let i = 0; i < n; i++) out[i] = f16(v[i]); }
  else out.set(new Float32Array(buf.slice(off, off + 4 * n)));
  return { data: out, ny, nx };
}
const cache = areaCache<string, Promise<any>>();
const memo = <T,>(key: string, f: () => Promise<T>): Promise<T> => {
  let p = cache.get(key);
  if (!p) { p = f().catch((e) => { cache.delete(key); throw e; }); cache.set(key, p); if (cache.size > 200) cache.delete(cache.keys().next().value as string); }
  return p;
};
const npy = (url: string) => memo(url, () => fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); }).then(parseNpy));
const alpha = (url: string) => memo(url, () => new Promise<Uint8ClampedArray>((ok, bad) => {
  const im = new Image(); im.crossOrigin = "anonymous";
  im.onload = () => { const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; const g = c.getContext("2d")!; g.drawImage(im, 0, 0); ok(g.getImageData(0, 0, c.width, c.height).data); };
  im.onerror = bad; im.src = url;
}));
const rgb = (name: string) => {
  const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d")!;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"; g.fillRect(0, 0, 1, 1);
  return g.getImageData(0, 0, 1, 1).data;
};
/** Depth change below this is shown as no change (metres). */
export const DIFF_MIN_M = 0.05;
/** Change at which the colour is fully opaque (metres). */
export const DIFF_FULL_M = 0.5;

/** PNG data URL of B minus A depth at frame time t: drier in B in the verified colour, wetter in hazard. Cells
 *  neither run draws (lagoon held at the tide level, shallow water) stay clear, as on the depth frames. */
export function diffFrame(runsBase: string, a: RunManifest, b: RunManifest, t: number): Promise<string> {
  const near = (m: RunManifest) => m.frames.reduce((best, f) => (Math.abs(f.t_s - t) < Math.abs(best.t_s - t) ? f : best), m.frames[0]);
  const fa = near(a), fb = near(b);
  return memo(`diff:${a.run_id}:${fa.t_s}:${b.run_id}:${fb.t_s}`, async () => {
    const [da, db, aa, ab] = await Promise.all([npy(runFileUrl(runsBase, a.run_id, fa.depth)), npy(runFileUrl(runsBase, b.run_id, fb.depth)),
      alpha(runFileUrl(runsBase, a.run_id, fa.png)), alpha(runFileUrl(runsBase, b.run_id, fb.png))]);
    const { nx, ny } = db, c = document.createElement("canvas"); c.width = nx; c.height = ny;
    const g = c.getContext("2d")!, img = g.createImageData(nx, ny), px = img.data;
    const dry = rgb("--verified"), wet = rgb("--hazard");
    for (let i = 0; i < nx * ny; i++) {
      if (!aa[4 * i + 3] && !ab[4 * i + 3]) continue;
      const d = (db.data[i] || 0) - (da.data[i] || 0);
      if (!(Math.abs(d) >= DIFF_MIN_M)) continue;
      const col = d < 0 ? dry : wet;
      px[4 * i] = col[0]; px[4 * i + 1] = col[1]; px[4 * i + 2] = col[2];
      px[4 * i + 3] = Math.round(255 * (0.35 + 0.65 * Math.min(1, Math.abs(d) / DIFF_FULL_M)));
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  });
}
