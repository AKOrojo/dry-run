/// <reference types="@webgpu/types" />
// In-browser 3D patch solver on WebGPU (owner: Eng A). The same box, window and one-way nesting as the OpenFOAM
// patch (dryrun/patch3d), solved with a free-surface method that suits a GPU:
// - water only, on a uniform MAC grid (cell_m horizontally, cell_m / 8 vertically), air as empty space (p = 0);
//   ground and buildings are the solid blocks below each column's floor kf (stair-stepped, as in OpenFOAM);
// - water fraction F per cell, advected by the conservative bounded split VOF scheme of Weymouth & Yue (2010),
//   then restacked in each column so the free surface is single-valued (no overturning);
// - pressure = hydrostatic (from F, per column) + a non-hydrostatic part q from a projection (red-black
//   vertical-line SOR, warm-started), so the velocity is divergence-free in the water;
// - momentum: semi-Lagrangian advection; bed and wall friction from the rough-wall log law (ks as OpenFOAM's
//   nutkRoughWallFunction), with a parabolic eddy viscosity in each water column (implicit);
// - sides: the outer ring of columns holds the 2D water level over time (the OpenFOAM side pressure), with the
//   same sponge band (SPONGE_CELLS wide, SPONGE_TAU_S) and the same 5 m/s speed cap.
// The output is the OpenFOAM patch's output: frames every 30 s in the same PNG encoding, and buildings.json with
// each building's peak net horizontal pressure force after the spin-up.

import { BOUNDARY, ADVECT_U, ADVECT_V, ADVECT_W, CORRECT, FRAME, HYDRO, MIX, PRESSURE, STACK, STATS, TICK, VOF, WG } from "./shaders";
import { floorLayers, type PatchInputs } from "./inputs";

export const BATCH = 48;  // most steps per command submission (per-step t and dt live in the clock buffer)
// GPU time per submission: browsers and drivers reset a device whose work runs for seconds without a break (the
// RX 6800 lost its device on one 48-step submission of 37 M cells), so big grids submit fewer steps at a time
const SUBMIT_S = 0.25;
const KAPPA = 0.41;
const EPS = 1e-3;
const CFL = 0.4;
const DT_MAX = 0.5;

export type SolverOptions = {
  pressureIters?: number;  // red-black line-SOR sweeps per step
  omega?: number;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
};
export type Progress = { t_s: number; t_end_s: number; fraction: number; steps: number; elapsed_s: number; dt_s: number };
export type FrameData = {
  t_s: number; depth: Float32Array; us: Float32Array; vs: Float32Array; um: Float32Array; vm: Float32Array;
  /** per building index: net horizontal force (N), [fx, fy] */
  force: Float32Array;
};
export type SolveResult = { frames: FrameData[]; steps: number; solve_s: number; cells: number; fluid_cells: number };

type Bufs = Record<string, GPUBuffer>;

export class PatchSolver {
  readonly nx: number; readonly ny: number; readonly nz: number;
  readonly ncell: number; readonly ncol: number; readonly nU: number; readonly nV: number; readonly nW: number;
  private b: Bufs = {};
  private pipes: Record<string, GPUComputePipeline> = {};
  private groups: Record<string, GPUBindGroup> = {};
  private kf: Uint32Array;

  constructor(private device: GPUDevice, private inp: PatchInputs) {
    const { nx, ny, nz } = inp;
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.ncol = nx * ny; this.ncell = nx * ny * nz;
    this.nU = (nx + 1) * ny * nz; this.nV = nx * (ny + 1) * nz; this.nW = nx * ny * (nz + 1);
    this.kf = floorLayers(inp);
  }

  get fluidCells(): number {
    let n = 0;
    for (let c = 0; c < this.ncol; c++) n += this.nz - this.kf[c];
    return n;
  }

  /** Buffers sized by memory.ts (bytesFor): keep the two in step. */
  private buffer(name: string, floats: number, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) {
    this.b[name] = this.device.createBuffer({ label: name, size: Math.max(16, Math.ceil(floats * 4 / 16) * 16), usage });
    return this.b[name];
  }

  private write(name: string, data: ArrayBufferView) {
    this.device.queue.writeBuffer(this.b[name], 0, data.buffer, data.byteOffset, data.byteLength);
  }

  init() {
    const { inp, nx, ny, nz, ncell, ncol } = this;
    const ph = inp.physics;
    for (const n of ["F", "Fb", "F0", "Ph", "Q"]) this.buffer(n, ncell);
    this.buffer("S", Math.max(2 * ncell, this.nU, this.nV));
    this.buffer("U", this.nU); this.buffer("U2", this.nU);
    this.buffer("V", this.nV); this.buffer("V2", this.nV);
    this.buffer("W", this.nW); this.buffer("W2", this.nW);
    this.buffer("kf", ncol);
    const perim = 2 * nx + 2 * ny, nt = inp.sides.t_s.length;
    this.buffer("bc", nt * perim);
    this.buffer("clk", 1 + 2 * BATCH);
    this.buffer("stats", 4);
    this.buffer("frame", 9 * ncol);
    this.b.uni = this.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const u = new ArrayBuffer(80), f = new Float32Array(u), w = new Uint32Array(u);
    w[0] = nx; w[1] = ny; w[2] = nz; w[3] = ncol;
    f[4] = inp.cell_m; f[5] = inp.dz; f[6] = ph.g; f[7] = ph.u_cap_m_s;
    f[8] = ph.ks_m / 30; f[9] = KAPPA; f[10] = ph.sponge_cells * inp.cell_m; f[11] = ph.sponge_tau_s;
    f[12] = inp.bc_dt_s; w[13] = nt; w[14] = perim; f[15] = EPS;
    f[16] = 1.0; f[17] = inp.request.size_m; f[18] = inp.zmin; f[19] = 0;
    this.uniform = u;
    this.device.queue.writeBuffer(this.b.uni, 0, u);

    this.write("kf", this.kf);
    // side levels [nt][perim]: south i, north nx + i, west 2 nx + j, east 2 nx + ny + j; dry (nan) -> -1e30
    const bc = new Float32Array(nt * perim);
    for (let t = 0; t < nt; t++) {
      const put = (arr: Float32Array, n: number, off: number) => {
        for (let s = 0; s < n; s++) { const v = arr[t * n + s]; bc[t * perim + off + s] = Number.isFinite(v) ? v : -1e30; }
      };
      put(inp.sides.south, nx, 0); put(inp.sides.north, nx, nx); put(inp.sides.west, ny, 2 * nx); put(inp.sides.east, ny, 2 * nx + ny);
    }
    this.write("bc", bc);

    // initial state from the 2D run at t0: column fill to the 2D level, depth-averaged velocity in the water
    const F = new Float32Array(ncell), U = new Float32Array(this.nU), V = new Float32Array(this.nV);
    const { wse, u: u2, v: v2 } = inp.init;
    const wet = (c: number) => Number.isFinite(wse[c]);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = i + nx * j;
      if (!wet(c)) continue;
      for (let k = this.kf[c]; k < nz; k++) {
        const zb = inp.zmin + k * inp.dz;
        F[i + nx * (j + ny * k)] = Math.min(Math.max((wse[c] - zb) / inp.dz, 0), 1);
      }
    }
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 1; i < nx; i++) {
      const l = i - 1 + nx * j, r = i + nx * j;
      if (k < Math.max(this.kf[l], this.kf[r])) continue;
      if (F[l + ncol * k] + F[r + ncol * k] < EPS) continue;
      const ul = wet(l) ? u2[l] : 0, ur = wet(r) ? u2[r] : 0;
      U[i + (nx + 1) * (j + ny * k)] = 0.5 * (ul + ur);
    }
    for (let k = 0; k < nz; k++) for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
      const l = i + nx * (j - 1), r = i + nx * j;
      if (k < Math.max(this.kf[l], this.kf[r])) continue;
      if (F[l + ncol * k] + F[r + ncol * k] < EPS) continue;
      const vl = wet(l) ? v2[l] : 0, vr = wet(r) ? v2[r] : 0;
      V[i + nx * (j + (ny + 1) * k)] = 0.5 * (vl + vr);
    }
    this.write("F", F); this.write("U", U); this.write("V", V);
    this.initialWater = F.reduce((a, x) => a + x, 0) * inp.cell_m * inp.cell_m * inp.dz;

    this.makePipelines();
  }
  private uniform!: ArrayBuffer;
  initialWater = 0;

  setOmega(omega: number) {
    new Float32Array(this.uniform)[16] = omega;
    this.device.queue.writeBuffer(this.b.uni, 0, this.uniform);
  }

  private makePipelines() {
    const d = this.device, b = this.b;
    const pipe = (name: string, code: string, constants?: Record<string, number>) => {
      const module = d.createShaderModule({ label: name, code });
      this.pipes[name] = d.createComputePipeline({ label: name, layout: "auto", compute: { module, entryPoint: "main", constants } });
    };
    // bufs[i] is binding i + 1; null for a binding the kernel does not use ("auto" layouts drop those)
    const group = (gname: string, pname: string, bufs: (GPUBuffer | null)[]) => {
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: b.uni } }];
      bufs.forEach((buffer, i) => { if (buffer) entries.push({ binding: i + 1, resource: { buffer } }); });
      this.groups[gname] = d.createBindGroup({ layout: this.pipes[pname].getBindGroupLayout(0), entries });
    };
    pipe("boundary", BOUNDARY); group("boundary", "boundary", [b.F, b.kf, b.bc, b.clk]);
    pipe("hydro", HYDRO); group("hydro", "hydro", [b.F, b.kf, b.Ph]);
    pipe("advU", ADVECT_U); group("advU", "advU", [b.U, b.V, b.W, b.F, b.kf, b.Ph, b.clk, b.U2]);
    pipe("advV", ADVECT_V); group("advV", "advV", [b.U, b.V, b.W, b.F, b.kf, b.Ph, b.clk, b.V2]);
    pipe("advW", ADVECT_W); group("advW", "advW", [b.U, b.V, b.W, b.F, b.kf, null, b.clk, b.W2]);
    pipe("mixU", MIX, { DIR: 0 }); group("mixU", "mixU", [b.U2, b.F, b.kf, b.S, b.clk]);
    pipe("mixV", MIX, { DIR: 1 }); group("mixV", "mixV", [b.V2, b.F, b.kf, b.S, b.clk]);
    for (const par of [0, 1]) {
      pipe(`p${par}`, PRESSURE, { PARITY: par }); group(`p${par}`, `p${par}`, [b.Q, b.U2, b.V2, b.W2, b.F, b.kf, b.S, b.clk]);
    }
    const dirs: [string, GPUBuffer][] = [["U", b.U2], ["V", b.V2], ["W", b.W2]];
    dirs.forEach(([n, buf], dir) => {
      pipe(`corr${n}`, CORRECT, { DIR: dir }); group(`corr${n}`, `corr${n}`, [buf, b.Q, b.F, b.kf, b.clk]);
    });
    pipe("vofX", VOF, { DIR: 0 }); group("vofX", "vofX", [b.F, b.Fb, b.F0, b.U2, b.kf, b.clk]);
    pipe("vofY", VOF, { DIR: 1 }); group("vofY", "vofY", [b.Fb, b.F, b.F0, b.V2, b.kf, b.clk]);
    pipe("vofZ", VOF, { DIR: 2 }); group("vofZ", "vofZ", [b.F, b.Fb, b.F0, b.W2, b.kf, b.clk]);
    pipe("stack", STACK); group("stack", "stack", [b.F, b.kf]);
    pipe("tick", TICK); group("tick", "tick", [b.clk]);
    pipe("stats", STATS); group("stats", "stats", [b.U, b.V, b.W, b.stats]);
    pipe("frame", FRAME); group("frame", "frame", [b.F, b.U, b.V, b.kf, b.Ph, b.Q, b.frame]);
  }

  private dispatch(pass: GPUComputePassEncoder, name: string, n: number, group = name) {
    pass.setPipeline(this.pipes[name]);
    pass.setBindGroup(0, this.groups[group]);
    const wgs = Math.ceil(n / WG);
    pass.dispatchWorkgroups(Math.min(wgs, 65535), Math.ceil(wgs / 65535));
  }

  /** Encode `n` steps (their t and dt already in the clock buffer). */
  private encodeSteps(enc: GPUCommandEncoder, n: number, iters: number) {
    const { ncol, ncell, nU, nV, nW } = this;
    const b = this.b;
    for (let s = 0; s < n; s++) {
      let pass = enc.beginComputePass();
      this.dispatch(pass, "boundary", ncol);
      this.dispatch(pass, "hydro", ncol);
      this.dispatch(pass, "advU", nU); this.dispatch(pass, "advV", nV); this.dispatch(pass, "advW", nW);
      this.dispatch(pass, "mixU", (this.nx + 1) * this.ny); this.dispatch(pass, "mixV", this.nx * (this.ny + 1));
      for (let it = 0; it < iters; it++) { this.dispatch(pass, "p0", ncol); this.dispatch(pass, "p1", ncol); }
      this.dispatch(pass, "corrU", nU); this.dispatch(pass, "corrV", nV); this.dispatch(pass, "corrW", nW);
      pass.end();
      enc.copyBufferToBuffer(b.F, 0, b.F0, 0, ncell * 4);
      pass = enc.beginComputePass();
      this.dispatch(pass, "vofX", ncell); this.dispatch(pass, "vofY", ncell); this.dispatch(pass, "vofZ", ncell);
      pass.end();
      enc.copyBufferToBuffer(b.Fb, 0, b.F, 0, ncell * 4);
      pass = enc.beginComputePass();
      this.dispatch(pass, "stack", ncol);
      pass.end();
      enc.copyBufferToBuffer(b.U2, 0, b.U, 0, nU * 4);
      enc.copyBufferToBuffer(b.V2, 0, b.V, 0, nV * 4);
      enc.copyBufferToBuffer(b.W2, 0, b.W, 0, nW * 4);
      pass = enc.beginComputePass();
      pass.setPipeline(this.pipes.tick); pass.setBindGroup(0, this.groups.tick); pass.dispatchWorkgroups(1);
      pass.end();
    }
  }

  private async readback(src: GPUBuffer, bytes: number, enc?: GPUCommandEncoder): Promise<ArrayBuffer> {
    const st = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const e = enc ?? this.device.createCommandEncoder();
    e.copyBufferToBuffer(src, 0, st, 0, bytes);
    this.device.queue.submit([e.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = st.getMappedRange().slice(0);
    st.unmap(); st.destroy();
    return out;
  }

  private async speeds(): Promise<[number, number]> {
    this.device.queue.writeBuffer(this.b.stats, 0, new Uint32Array(4));
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    this.dispatch(pass, "stats", Math.max(this.nU, this.nV, this.nW));
    pass.end();
    const f = new Float32Array(await this.readback(this.b.stats, 16, enc));
    return [f[0], f[1]];
  }

  private async frame(t_s: number): Promise<FrameData> {
    const { ncol, nx, ny } = this;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    this.dispatch(pass, "hydro", ncol);
    this.dispatch(pass, "frame", ncol);
    pass.end();
    const o = new Float32Array(await this.readback(this.b.frame, 9 * ncol * 4, enc));
    const depth = new Float32Array(ncol), us = new Float32Array(ncol), vs = new Float32Array(ncol), um = new Float32Array(ncol), vm = new Float32Array(ncol);
    const nb = this.inp.building_ids.length, force = new Float32Array(2 * nb);
    const bld = this.inp.building;
    for (let c = 0; c < ncol; c++) {
      depth[c] = o[9 * c]; us[c] = o[9 * c + 1]; vs[c] = o[9 * c + 2]; um[c] = o[9 * c + 3]; vm[c] = o[9 * c + 4];
      const i = c % nx, j = Math.floor(c / nx);
      // force on the neighbour's solid wall: E pushes +x, W -x, N +y, S -y
      const nbs: [number, number, number, number][] = [[i + 1, j, 1, 0], [i - 1, j, -1, 0], [i, j + 1, 0, 1], [i, j - 1, 0, -1]];
      nbs.forEach(([a, bb, sx, sy], s) => {
        const fv = o[9 * c + 5 + s];
        if (fv === 0 || a < 0 || bb < 0 || a >= nx || bb >= ny) return;
        const id = bld[a + nx * bb];
        if (id < 0) return;
        force[2 * id] += sx * fv; force[2 * id + 1] += sy * fv;
      });
    }
    return { t_s, depth, us, vs, um, vm, force };
  }

  /** Solve the window; frames at 0, frame_dt, ... (seconds since the window start). */
  async run(opts: SolverOptions = {}): Promise<SolveResult> {
    const { inp } = this;
    const iters = opts.pressureIters ?? 12;
    this.setOmega(opts.omega ?? 1.5);
    const tEnd = inp.t_window_s[1] - inp.t_window_s[0];
    const H = this.nz * inp.dz;
    const dtWave = 0.5 * inp.cell_m / Math.sqrt(inp.physics.g * H);
    const frames: FrameData[] = [];
    const t0 = performance.now();
    let t = 0, steps = 0, umax = 1, wmax = 0.1, nextFrame = 0, perStep = 0;
    const clk = new Float32Array(1 + 2 * BATCH);
    while (true) {
      if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
      if (t >= nextFrame - 1e-6) {
        frames.push(await this.frame(inp.t_window_s[0] + nextFrame));
        nextFrame += inp.frame_dt_s;
        if (nextFrame > tEnd + 1e-6) break;
      }
      let dt = Math.min(DT_MAX, CFL * inp.cell_m / Math.max(umax, 0.3), CFL * inp.dz / Math.max(wmax, 0.05), dtWave);
      if (steps === 0) dt = Math.min(dt, 0.02);
      // land exactly on the next frame time
      const remaining = nextFrame - t;
      const need = Math.ceil(remaining / dt - 1e-9);
      const n = Math.min(need, perStep > 0 ? Math.max(1, Math.floor(SUBMIT_S / perStep)) : 1, BATCH);
      dt = remaining / need;
      clk[0] = 0;
      for (let s = 0; s < n; s++) { clk[1 + 2 * s] = t + s * dt; clk[2 + 2 * s] = dt; }
      this.device.queue.writeBuffer(this.b.clk, 0, clk);
      const enc = this.device.createCommandEncoder();
      this.encodeSteps(enc, n, iters);
      const ts = performance.now();
      this.device.queue.submit([enc.finish()]);
      t += n * dt; steps += n;
      [umax, wmax] = await this.speeds();
      const took = (performance.now() - ts) / 1000 / n;
      perStep = perStep > 0 ? 0.7 * perStep + 0.3 * took : took;
      if (!Number.isFinite(umax) || !Number.isFinite(wmax)) throw new Error(`solver diverged at t = ${t.toFixed(1)} s`);
      opts.onProgress?.({ t_s: t, t_end_s: tEnd, fraction: Math.min(t / tEnd, 1), steps,
                          elapsed_s: (performance.now() - t0) / 1000, dt_s: dt });
    }
    return { frames, steps, solve_s: (performance.now() - t0) / 1000, cells: this.ncell, fluid_cells: this.fluidCells };
  }

  destroy() { for (const x of Object.values(this.b)) x.destroy(); }
}
