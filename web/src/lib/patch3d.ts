// 3D close-up (precomputed OpenFOAM patch nested in a 2D run): data loading, frame decoding and the shared state
// (pattern of lib/waypoints.ts). The map layer, the sidebar cards and the dock all read this store.
import { useSyncExternalStore } from "react";
import { API } from "./api";

export type PatchRow = {
  patch_id: string; status: string; center: [number, number]; size_m: number; cell_m: number;
  bounds_wgs84: [number, number, number, number]; t_window_s: [number, number];
};
export type PatchManifest = {
  patch_id: string; solver: string; bounds_wgs84: [number, number, number, number]; nx: number; ny: number; t_window_s: [number, number];
  frames: { t_s: number; surface: string; velocity: string }[];
  encoding: { surface?: string; velocity?: string; vmax_m_s?: number; depth_max_m?: number };
  checks: { spinup_s?: number; water_volume_3d_m3?: number[]; water_volume_2d_m3?: number[]; volume_diff_end_pct?: number };
  request?: { size_m?: number; cell_m?: number };
};
export type PatchForces = { ids: string[]; peak_force_kN: number[]; t_s: number[]; direction_deg: number[]; method?: string };
/** One decoded frame. Cell arrays are row-major, row 0 = north. */
export type Frame = { depth: Float32Array; us: Float32Array; vs: Float32Array; um: Float32Array; vm: Float32Array };
export type PatchBuilding = { id: string; lon: number; lat: number; height_m: number; kN: number; t_s: number; dir_deg: number };
export type PatchData = {
  row: PatchRow; manifest: PatchManifest; forces: PatchForces; frames: Frame[]; buildings: PatchBuilding[];
  spinup_s: number; maxDepth: number;
  series: { maxDepth: number[]; maxSpeed: number[] };
};

export type Show = { water: boolean; arrows: boolean; forces: boolean; twoD: boolean };
export type CloseUpState = {
  runId: string | null; patches: PatchRow[];
  /** The patch being viewed (set when the chip is clicked), and its data once loaded. */
  active: string | null; status: "idle" | "loading" | "ready" | "error"; data: PatchData | null;
  show: Show; channel: "surface" | "mid"; playing: boolean;
  /** A request for the map to fly to a building (set by the dock, consumed by the map layer). */
  fly: { lon: number; lat: number; height_m: number } | null;
};

let state: CloseUpState = {
  runId: null, patches: [], active: null, status: "idle", data: null,
  show: { water: true, arrows: true, forces: true, twoD: false }, channel: "surface", playing: false, fly: null,
};
const subs = new Set<() => void>();
export const closeup = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
};
export const useCloseUp = () => useSyncExternalStore(closeup.subscribe, closeup.get);
export function setCloseUp(patch: Partial<CloseUpState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export const setShow = (patch: Partial<Show>) => setCloseUp({ show: { ...state.show, ...patch } });

// ---- discovery ----
/** The patches of a run (404, an error or none = an empty list). */
export async function listPatches(runId: string): Promise<PatchRow[]> {
  try {
    const r = await fetch(`${API}/api/runs/${runId}/patch3d`);
    if (!r.ok) return [];
    const j = await r.json();
    return (Array.isArray(j?.patches) ? j.patches : []).filter((p: PatchRow) => p?.status === "done" && Array.isArray(p.bounds_wgs84));
  } catch { return []; }
}

// ---- PNG decoding ----
// Frames carry data in all four channels (mid-depth v is in alpha), so a canvas (which premultiplies) would corrupt them.
// 8-bit RGBA PNGs are decoded here exactly; anything else goes through an offscreen canvas and getImageData.
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function decodeExact(buf: ArrayBuffer): Promise<{ w: number; h: number; rgba: Uint8Array } | null> {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  if (b.length < 33 || dv.getUint32(0) !== 0x89504e47 || typeof DecompressionStream === "undefined") return null;
  let w = 0, h = 0, ok = false;
  const parts: Uint8Array[] = [];
  for (let p = 8; p + 8 <= b.length;) {
    const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const d = p + 8;
    if (type === "IHDR") { w = dv.getUint32(d); h = dv.getUint32(d + 4); ok = b[d + 8] === 8 && b[d + 9] === 6 && b[d + 12] === 0; }
    else if (type === "IDAT") parts.push(b.subarray(d, d + len));
    else if (type === "IEND") break;
    p = d + len + 4;
  }
  if (!ok || !w || !h || !parts.length) return null;
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0; for (const x of parts) { all.set(x, o); o += x.length; }
  const raw = await inflate(all);
  const stride = w * 4, out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= 4 ? out[dst + i - 4] : 0, up = y ? out[dst - stride + i] : 0, c = i >= 4 && y ? out[dst - stride + i - 4] : 0;
      let v = x;
      if (f === 1) v = x + a;
      else if (f === 2) v = x + up;
      else if (f === 3) v = x + ((a + up) >> 1);
      else if (f === 4) { const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); }
      out[dst + i] = v & 255;
    }
  }
  return { w, h, rgba: out };
}
async function decodeCanvas(buf: ArrayBuffer): Promise<{ w: number; h: number; rgba: Uint8Array }> {
  const bmp = await createImageBitmap(new Blob([buf]), { premultiplyAlpha: "none" });
  const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  return { w: c.width, h: c.height, rgba: new Uint8Array(g.getImageData(0, 0, c.width, c.height).data.buffer) };
}
const pngCache = new Map<string, Promise<{ w: number; h: number; rgba: Uint8Array }>>();
/** Exact RGBA of a PNG, cached by url (non-premultiplied: velocity frames keep data under alpha 0). */
export function decodePng(url: string) {
  let p = pngCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); })
      .then(async (buf) => (await decodeExact(buf)) ?? decodeCanvas(buf));
    p.catch(() => pngCache.delete(url));
    pngCache.set(url, p);
  }
  return p;
}

/** depth_m = (R*256+G)/65535*depth_max, wet where A > 0; velocity: surface u,v from R,G; mid-depth from B,A. */
async function decodeFrame(surfaceUrl: string, velocityUrl: string, nx: number, ny: number, depthMax: number, s: number): Promise<Frame> {
  const [sf, vl] = await Promise.all([decodePng(surfaceUrl), decodePng(velocityUrl)]);
  const n = nx * ny, f: Frame = { depth: new Float32Array(n), us: new Float32Array(n), vs: new Float32Array(n), um: new Float32Array(n), vm: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    if (sf.rgba[i * 4 + 3] > 0) {
      f.depth[i] = ((sf.rgba[i * 4] * 256 + sf.rgba[i * 4 + 1]) / 65535) * depthMax;
      f.us[i] = (vl.rgba[i * 4] - 128) * s; f.vs[i] = (vl.rgba[i * 4 + 1] - 128) * s;
      f.um[i] = (vl.rgba[i * 4 + 2] - 128) * s; f.vm[i] = (vl.rgba[i * 4 + 3] - 128) * s;
    }
  }
  return f;
}

/** Building footprint centroids and heights, matched by properties.id. */
async function footprints(url: string | undefined, ids: string[]): Promise<Map<string, { lon: number; lat: number; height_m: number }>> {
  const out = new Map<string, { lon: number; lat: number; height_m: number }>();
  if (!url) return out;
  const want = new Set(ids);
  try {
    const fc = await fetch(url).then((r) => r.json());
    for (const f of fc?.features ?? []) {
      const id = String(f?.properties?.id);
      const ring = f?.geometry?.type === "Polygon" ? f.geometry.coordinates?.[0] : null;
      if (!want.has(id) || !Array.isArray(ring) || ring.length < 3) continue;
      const pts = ring.length > 3 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
      const h = f.properties.height_m;
      out.set(id, { lon: pts.reduce((a: number, p: number[]) => a + p[0], 0) / pts.length, lat: pts.reduce((a: number, p: number[]) => a + p[1], 0) / pts.length,
        height_m: typeof h === "number" && Number.isFinite(h) ? Math.max(3, h) : 3 });
    }
  } catch { /* forces then have no anchor and are left out */ }
  return out;
}

/** Everything for one patch: manifest, forces, all frames decoded and cached, building positions. */
export async function loadPatch(runsBase: string, runId: string, row: PatchRow, buildingsUrl?: string): Promise<PatchData> {
  // Files are public under the runs base (the same place the frame paths resolve); the API route redirects there.
  const rel = `patch3d/${row.patch_id}`;
  const get = async (name: string) => {
    for (const u of [`${runsBase.replace(/\/$/, "")}/${runId}/${rel}/${name}`, `${API}/api/runs/${runId}/${rel}/${name}`]) {
      try { const r = await fetch(u); if (r.ok) return await r.json(); } catch { /* try the next */ }
    }
    return null;
  };
  const [manifest, forces] = await Promise.all([
    get("manifest.json").then((m) => { if (!m) throw new Error("manifest"); return m as PatchManifest; }),
    get("buildings.json") as Promise<PatchForces | null>,
  ]);
  const f = forces ?? { ids: [], peak_force_kN: [], t_s: [], direction_deg: [] };
  const run = `${runsBase.replace(/\/$/, "")}/${runId}/`;
  const depthMax = manifest.encoding?.depth_max_m ?? 4;
  const s = (manifest.encoding?.vmax_m_s ?? 4) / 127;
  const [frames, fp] = await Promise.all([
    Promise.all(manifest.frames.map((fr) => decodeFrame(run + fr.surface, run + fr.velocity, manifest.nx, manifest.ny, depthMax, s))),
    footprints(buildingsUrl, f.ids),
  ]);
  const buildings: PatchBuilding[] = [];
  f.ids.forEach((id, i) => {
    const p = fp.get(String(id));
    if (p) buildings.push({ id: String(id), ...p, kN: f.peak_force_kN[i], t_s: f.t_s[i], dir_deg: f.direction_deg[i] });
  });
  const spinup_s = manifest.checks?.spinup_s ?? 120;
  const maxDepth = frames.reduce((m, fr) => fr.depth.reduce((a, v) => Math.max(a, v), m), 0);
  const series = {
    maxDepth: frames.map((fr) => fr.depth.reduce((a, v) => Math.max(a, v), 0)),
    maxSpeed: frames.map((fr) => { let m = 0; for (let i = 0; i < fr.depth.length; i++) if (fr.depth[i] > 0) m = Math.max(m, Math.hypot(fr.us[i], fr.vs[i])); return m; }),
  };
  return { row, manifest, forces: f, frames, buildings, spinup_s, maxDepth, series };
}

// ---- helpers shared by the map, sidebar and dock ----
/** Frame index for a run time (clamped to the patch window). */
export function frameIndex(m: PatchManifest, t_s: number): number {
  const n = m.frames.length;
  if (n < 2) return 0;
  const t0 = m.frames[0].t_s, step = (m.frames[n - 1].t_s - t0) / (n - 1);
  return Math.min(n - 1, Math.max(0, Math.round((t_s - t0) / step)));
}
/** First frame after the settling (spin-up) time. */
export const firstSettledIndex = (m: PatchManifest, spinup: number) => {
  const i = m.frames.findIndex((fr) => fr.t_s >= m.frames[0].t_s + spinup);
  return i < 0 ? 0 : i;
};
/** "less" or "more", and the rounded percentage, for the volume caveat. */
export const volumeCaveat = (pct: number | undefined) => (typeof pct === "number" && pct !== 0 ? { word: pct < 0 ? "less" : "more", pct: Math.abs(Math.round(pct)) } : null);
/** Extra metres of ground lift so the water sits just above the terrain mesh. */
export const WATER_LIFT_M = 0.1;
