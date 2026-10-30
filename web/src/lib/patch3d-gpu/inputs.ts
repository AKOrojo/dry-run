// Inputs for the in-browser 3D patch solver: GET /api/runs/{run_id}/patch3d_inputs (dryrun/patch3d/inputs.py).
// The same box, window and 2D forcing the OpenFOAM patch uses. Arrays are [ny, nx] row-major, row 0 = SOUTH.

export type PatchInputsDoc = {
  version: number; patch_id: string;
  request: { run_id: string; center: [number, number]; size_m: number; cell_m: number; t_window_s: [number, number] | null };
  bounds_wgs84: [number, number, number, number]; nx: number; ny: number; nz: number; cell_m: number; dz: number; zmin: number;
  t_window_s: [number, number]; bc_dt_s: number; frame_dt_s: number; spinup_s: number;
  ground: string; top: string; building: string; building_ids: string[];
  init: { wse: string; u: string; v: string };
  sides: { t_s: number[]; south: string; north: string; west: string; east: string };
  vol2_m3: number[];
  physics: { g: number; rho_water: number; ks_m: number; u_cap_m_s: number; sponge_cells: number; sponge_tau_s: number; dry_m: number };
  encoding: { depth_max_m: number };
};

export type PatchInputs = Omit<PatchInputsDoc, "ground" | "top" | "building" | "init" | "sides"> & {
  ground: Float32Array; top: Float32Array; building: Int32Array;
  init: { wse: Float32Array; u: Float32Array; v: Float32Array };
  sides: { t_s: number[]; south: Float32Array; north: Float32Array; west: Float32Array; east: Float32Array };
};

function bytes(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}
const f32 = (b64: string) => new Float32Array(bytes(b64));

export function decodeInputs(d: PatchInputsDoc): PatchInputs {
  return {
    ...d, ground: f32(d.ground), top: f32(d.top), building: new Int32Array(bytes(d.building)),
    init: { wse: f32(d.init.wse), u: f32(d.init.u), v: f32(d.init.v) },
    sides: { t_s: d.sides.t_s, south: f32(d.sides.south), north: f32(d.sides.north), west: f32(d.sides.west), east: f32(d.sides.east) },
  };
}

export async function fetchInputs(api: string, runId: string, center: [number, number], sizeM: number, cellM: number,
                                  signal?: AbortSignal): Promise<PatchInputs> {
  const q = new URLSearchParams({ lon: String(center[0]), lat: String(center[1]), size_m: String(sizeM), cell_m: String(cellM) });
  const r = await fetch(`${api}/api/runs/${runId}/patch3d_inputs?${q}`, { signal });
  if (!r.ok) throw new Error(`patch inputs: HTTP ${r.status} ${await r.text().catch(() => "")}`.trim());
  return decodeInputs(await r.json());
}

/** First fluid layer of each column: cells below the ground or inside a building are solid (geometry.Patch.solid). */
export function floorLayers(inp: PatchInputs): Uint32Array {
  const { nx, ny, nz, dz, zmin } = inp;
  const kf = new Uint32Array(nx * ny);
  for (let c = 0; c < nx * ny; c++) {
    const top = inp.building[c] >= 0 && Number.isFinite(inp.top[c]) ? Math.max(inp.top[c], inp.ground[c]) : inp.ground[c];
    // solid where the cell centre zmin + (k + 0.5) dz < top
    let k = Math.ceil((top - zmin) / dz - 0.5);
    if (zmin + (k + 0.5) * dz < top) k++;
    kf[c] = Math.min(Math.max(k, 0), nz);
  }
  return kf;
}
