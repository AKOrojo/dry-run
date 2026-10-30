// GPU memory of the in-browser patch solver, and what fits a budget (the UI's GPU-memory setting).
// Keep in step with PatchSolver.init: 13 float32 per cell (F, F scratch, F at step start, hydrostatic and
// non-hydrostatic pressure, 2 for the line solver, 6 for the face velocities and their new values), plus small
// per-column buffers. Measured on the RX 6800: the counts below are the buffers it allocates.

export const VERTICAL_RATIO = 8;  // dz = cell_m / 8 (dryrun/patch3d/geometry.py)
export const SPAN_PAD_M = 2.0;  // 0.5 m of solid below the lowest ground + 1.5 m of air above the highest water
export const USABLE = 0.9;  // leave headroom in the budget for the browser and the frame readback

export type Dims = { nx: number; ny: number; nz: number };

export function bytesFor({ nx, ny, nz }: Dims, bcTimes = 21): { total: number; largest: number } {
  const ncell = nx * ny * nz, ncol = nx * ny;
  const nU = (nx + 1) * ny * nz, nV = nx * (ny + 1) * nz, nW = nx * ny * (nz + 1);
  const scratch = Math.max(2 * ncell, nU, nV);
  const floats = 5 * ncell + scratch + 2 * (nU + nV + nW) + ncol * (1 + 9) + bcTimes * (2 * nx + 2 * ny) + 1 + 2 * 48 + 4;
  return { total: floats * 4 + 9 * ncol * 4, largest: Math.max(scratch, nU, nV, nW) * 4 };
}

/** Grid of a square box: size_m / cell_m columns a side, layers over the vertical span (terrain relief plus water). */
export function dimsFor(sizeM: number, cellM: number, spanM: number): Dims {
  const n = Math.round(sizeM / cellM);
  return { nx: n, ny: n, nz: Math.ceil((spanM + SPAN_PAD_M) / (cellM / VERTICAL_RATIO)) };
}

export type Fit = { fits: boolean; need_mb: number; budget_mb: number; reason?: string };

/** Whether a grid fits `budgetMb` of GPU memory and the device's per-buffer limit. */
export function fits(d: Dims, budgetMb: number, maxBufferBytes = Infinity): Fit {
  const b = bytesFor(d);
  const need_mb = Math.ceil(b.total / 2 ** 20);
  if (b.largest > maxBufferBytes) return { fits: false, need_mb, budget_mb: budgetMb, reason: "a buffer is larger than this GPU allows" };
  if (b.total > budgetMb * 2 ** 20 * USABLE) return { fits: false, need_mb, budget_mb: budgetMb, reason: "needs more GPU memory than allowed" };
  return { fits: true, need_mb, budget_mb: budgetMb };
}

/** Largest box (m, a multiple of 10, 60-500) at a cell size that fits a budget, or null if even 60 m does not. */
export function largestBox(cellM: number, spanM: number, budgetMb: number, maxBufferBytes = Infinity): number | null {
  let best: number | null = null;
  for (let s = 60; s <= 500; s += 10) {
    if (Math.round(s / cellM) > 1000) break;
    if (fits(dimsFor(s, cellM, spanM), budgetMb, maxBufferBytes).fits) best = s;
  }
  return best;
}
