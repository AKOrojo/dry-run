/// <reference types="@webgpu/types" />
// In-browser 3D close-up (owner: Eng A; the UI is Eng B's). Solves a patch on the viewer's GPU (WebGPU) from the
// same inputs as the precomputed OpenFOAM patches and returns the same outputs: a manifest whose frames are PNG
// blob URLs in the OpenFOAM encoding, buildings.json (peak forces), and the decoded frames.
//
//   if (!gpuAvailable()) -> fall back to the precomputed patches
//   const d = await patchDims(API, runId, center, size_m, cell_m);          // grid, before any download
//   const f = fits(d, memoryMb, maxBuffer);                                 // memory.ts; f.need_mb for the slider
//   const r = await solvePatchInBrowser(API, runId, center, size_m, cell_m, { memoryMb, onProgress, signal });
//   // r.manifest + r.forces + r.frames -> lib/patch3d.ts assemblePatch(...) -> the close-up viewer, unchanged

import { decodeInputs, type PatchInputs, type PatchInputsDoc } from "./inputs";
import { fits, type Dims } from "./memory";
import { encodePng, surfaceRgba, velocityRgba } from "./png";
import { PatchSolver, type FrameData, type Progress } from "./solver";

export { fits, largestBox, dimsFor, bytesFor } from "./memory";
export type { Progress } from "./solver";

export const SOLVER_NAME = "Dry Run WebGPU free-surface VOF (in the browser), one-way nested in the 2D run";

export function gpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && !!(navigator as Navigator & { gpu?: GPU }).gpu;
}

/** The adapter's largest buffer (bytes), for fits(); null without WebGPU. */
export async function gpuLimits(): Promise<{ maxBuffer: number; description: string } | null> {
  if (!gpuAvailable()) return null;
  const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!ad) return null;
  const info = (ad as GPUAdapter & { info?: GPUAdapterInfo }).info;
  return { maxBuffer: Math.min(ad.limits.maxStorageBufferBindingSize, ad.limits.maxBufferSize),
           description: [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ") };
}

const query = (center: [number, number], sizeM: number, cellM: number, extra: Record<string, string> = {}) =>
  new URLSearchParams({ lon: String(center[0]), lat: String(center[1]), size_m: String(sizeM), cell_m: String(cellM), ...extra });

export type PatchDims = Dims & { patch_id: string; cell_m: number; dz: number; span_m: number; cells: number; t_window_s: [number, number] };

export async function patchDims(api: string, runId: string, center: [number, number], sizeM: number, cellM: number,
                                signal?: AbortSignal): Promise<PatchDims> {
  const r = await fetch(`${api}/api/runs/${runId}/patch3d_inputs?${query(center, sizeM, cellM, { dims_only: "1" })}`, { signal });
  if (!r.ok) throw new Error(`patch grid: HTTP ${r.status} ${await r.text().catch(() => "")}`.trim());
  return r.json();
}

export type Phase = "inputs" | "solving" | "encoding";
export type SolveOptions = {
  memoryMb: number;
  onProgress?: (p: { phase: Phase } & Partial<Progress>) => void;
  signal?: AbortSignal;
  pressureIters?: number;
};
/** Matches lib/patch3d.ts PatchManifest / PatchForces / Frame (frames there are row 0 = NORTH). */
export type BrowserPatch = {
  manifest: {
    patch_id: string; solver: string; bounds_wgs84: [number, number, number, number]; nx: number; ny: number;
    t_window_s: [number, number]; frames: { t_s: number; surface: string; velocity: string }[];
    encoding: { surface: string; velocity: string; vmax_m_s: number; depth_max_m: number; ground: string };
    checks: Record<string, unknown> & { spinup_s: number; water_volume_3d_m3: number[]; water_volume_2d_m3: number[]; volume_diff_end_pct: number | null };
    request: { size_m: number; cell_m: number }; cells: number; elapsed_s: number;
  };
  forces: { ids: string[]; peak_force_kN: number[]; t_s: number[]; direction_deg: number[]; excluded_at_box_edge: string[]; method: string };
  frames: { depth: Float32Array; us: Float32Array; vs: Float32Array; um: Float32Array; vm: Float32Array }[];
  /** blob: URLs of the frame PNGs; call release() when the patch is closed */
  release: () => void;
};

export class GpuError extends Error {
  constructor(message: string, readonly kind: "no-webgpu" | "too-large" | "device-lost" | "inputs") { super(message); }
}

export async function solvePatchInBrowser(api: string, runId: string, center: [number, number], sizeM: number, cellM: number,
                                          opts: SolveOptions): Promise<BrowserPatch> {
  if (!gpuAvailable()) throw new GpuError("WebGPU is not available in this browser", "no-webgpu");
  const t0 = performance.now();
  opts.onProgress?.({ phase: "inputs" });
  const r = await fetch(`${api}/api/runs/${runId}/patch3d_inputs?${query(center, sizeM, cellM)}`, { signal: opts.signal });
  if (!r.ok) throw new GpuError(`patch inputs: HTTP ${r.status} ${await r.text().catch(() => "")}`.trim(), "inputs");
  const inp = decodeInputs((await r.json()) as PatchInputsDoc);
  const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!ad) throw new GpuError("no WebGPU adapter", "no-webgpu");
  const maxBuffer = Math.min(ad.limits.maxStorageBufferBindingSize, ad.limits.maxBufferSize);
  const fit = fits(inp, opts.memoryMb, maxBuffer);
  if (!fit.fits) throw new GpuError(`${fit.reason}: ${fit.need_mb} MB for ${inp.nx} x ${inp.ny} x ${inp.nz} cells`, "too-large");
  // the kernels bind at most 8 storage buffers (the WebGPU default); only the buffer sizes need raising
  const device = await ad.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: maxBuffer, maxBufferSize: maxBuffer } });
  let lost = false;
  device.lost.then(() => { lost = true; });
  const solver = new PatchSolver(device, inp);
  try {
    solver.init();
    const res = await solver.run({
      pressureIters: opts.pressureIters, signal: opts.signal,
      onProgress: (p) => opts.onProgress?.({ phase: "solving", ...p }),
    });
    opts.onProgress?.({ phase: "encoding" });
    return await outputs(inp, res.frames, { cells: res.cells, fluid_cells: res.fluid_cells, steps: res.steps,
                                            solve_s: Math.round(res.solve_s * 10) / 10 }, (performance.now() - t0) / 1000);
  } catch (e) {
    if (lost) throw new GpuError("the GPU reset during the solve (try a smaller box or a coarser cell)", "device-lost");
    throw e;
  } finally {
    solver.destroy();
    device.destroy();
  }
}

/** Frames, forces and checks as dryrun/patch3d/run.py post_process writes them. */
export async function outputs(inp: PatchInputs, frames: FrameData[], extra: Record<string, unknown>, elapsedS: number): Promise<BrowserPatch> {
  const { nx, ny } = inp;
  const depthMax = inp.encoding.depth_max_m;
  let vmaxRaw = 0.01;
  for (const f of frames) for (let c = 0; c < nx * ny; c++) {
    vmaxRaw = Math.max(vmaxRaw, Math.abs(f.us[c]), Math.abs(f.vs[c]), Math.abs(f.um[c]), Math.abs(f.vm[c]));
  }
  const vmax = Math.max(0.5, Math.ceil(vmaxRaw * 2) / 2);
  const urls: string[] = [];
  const url = (png: Uint8Array) => { const u = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" })); urls.push(u); return u; };
  const mframes: BrowserPatch["manifest"]["frames"] = [];
  const decoded: BrowserPatch["frames"] = [];
  const north = (a: Float32Array) => { const o = new Float32Array(nx * ny); for (let j = 0; j < ny; j++) o.set(a.subarray(nx * j, nx * (j + 1)), nx * (ny - 1 - j)); return o; };
  for (const f of frames) {
    const [s, v] = await Promise.all([encodePng(nx, ny, surfaceRgba(f.depth, nx, ny, depthMax)),
                                      encodePng(nx, ny, velocityRgba(f.us, f.vs, f.um, f.vm, nx, ny, vmax))]);
    mframes.push({ t_s: Math.round(f.t_s * 10) / 10, surface: url(s), velocity: url(v) });
    const d = north(f.depth), dry = (x: Float32Array) => { const o = north(x); for (let i = 0; i < o.length; i++) if (d[i] < 0.02) o[i] = 0; return o; };
    decoded.push({ depth: d.map((x) => (x >= 0.02 ? x : 0)), us: dry(f.us), vs: dry(f.vs), um: dry(f.um), vm: dry(f.vm) });
  }
  // forces: peak after the spin-up; footprints cut by the box edge or reaching into the sponge band are left out
  const k = inp.physics.sponge_cells, b = inp.building, edge = new Set<number>();
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if ((i < k || j < k || i >= nx - k || j >= ny - k) && b[i + nx * j] >= 0) edge.add(b[i + nx * j]);
  }
  const t0 = inp.t_window_s[0];
  const forces: BrowserPatch["forces"] = {
    ids: [], peak_force_kN: [], t_s: [], direction_deg: [], excluded_at_box_edge: [...edge].sort((x, y) => x - y).map((i) => inp.building_ids[i]),
    method: "net horizontal pressure force on each footprint's wall faces from the 3D solve (pressure relative to the "
      + `open top); no shear; stair-stepped walls at cell_m; frames after the ${inp.spinup_s} s spin-up only; buildings `
      + `reaching into the ${k * inp.cell_m} m side sponge band are excluded`,
  };
  inp.building_ids.forEach((id, i) => {
    if (edge.has(i)) return;
    let best = -1, bf = 0;
    frames.forEach((f, n) => {
      if (f.t_s - t0 < inp.spinup_s) return;
      const m = Math.hypot(f.force[2 * i], f.force[2 * i + 1]);
      if (m > bf) { bf = m; best = n; }
    });
    if (best < 0) return;
    const f = frames[best];
    forces.ids.push(id);
    forces.peak_force_kN.push(Math.round(bf / 10) / 100);
    forces.t_s.push(Math.round(f.t_s * 10) / 10);
    forces.direction_deg.push(Math.round(((Math.atan2(f.force[2 * i], f.force[2 * i + 1]) * 180) / Math.PI + 360) % 360));
  });
  // water volume over the building-free columns, against the 2D run's (the OpenFOAM manifest's check)
  const area = inp.cell_m * inp.cell_m;
  const vol3 = frames.map((f) => { let v = 0; for (let c = 0; c < nx * ny; c++) if (b[c] < 0) v += f.depth[c] * area; return Math.round(v * 10) / 10; });
  const vol2 = inp.vol2_m3.slice(0, vol3.length);
  const last = vol3.length - 1;
  const manifest: BrowserPatch["manifest"] = {
    patch_id: inp.patch_id, solver: SOLVER_NAME, bounds_wgs84: inp.bounds_wgs84, nx, ny, t_window_s: inp.t_window_s,
    frames: mframes,
    encoding: {
      surface: `depth_m = (R*256 + G) / 65535 * ${depthMax}; A = 255 where depth >= 0.02 m; depth is the water column above the local floor (ground, or a roof); north-up`,
      velocity: `surface u = (R-128)*s, v = (G-128)*s; mid-depth u = (B-128)*s, v = (A-128)*s; s = ${(vmax / 127).toFixed(6)} m/s; u east, v north; north-up`,
      vmax_m_s: vmax, depth_max_m: depthMax,
      ground: "patch ground = the AOI DEM, bilinear; building tops = highest ground under the footprint + height_m",
    },
    checks: { spinup_s: inp.spinup_s, water_volume_3d_m3: vol3, water_volume_2d_m3: vol2,
              volume_diff_end_pct: vol2[last] > 0 ? Math.round((1000 * (vol3[last] - vol2[last])) / vol2[last]) / 10 : null,
              sponge_m: k * inp.cell_m, blocks: [nx, ny, inp.nz], dz_m: inp.dz, ...extra },
    request: { size_m: inp.request.size_m, cell_m: inp.request.cell_m },
    cells: Number(extra.fluid_cells ?? 0), elapsed_s: Math.round(elapsedS * 10) / 10,
  };
  return { manifest, forces, frames: decoded, release: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}
