// Frame PNGs in the encoding of dryrun/patch3d/post.py, so lib/patch3d.ts decodes browser-solved frames exactly as
// it decodes OpenFOAM ones. 8-bit RGBA, no interlace, filter 0; zlib from CompressionStream("deflate").

let CRC: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(raw: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** rgba: w * h * 4 bytes, rows top (north) first. */
export async function encodePng(w: number, h: number, rgba: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", await zlib(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** post.surface_png: depth = (R*256 + G) / 65535 * vmax; A = 255 where depth >= 0.02 m. depth rows: row 0 = south. */
export function surfaceRgba(depth: Float32Array, nx: number, ny: number, vmax: number): Uint8Array {
  const out = new Uint8Array(nx * ny * 4);
  for (let r = 0; r < ny; r++) {
    const j = ny - 1 - r;  // north-up
    for (let i = 0; i < nx; i++) {
      const d = depth[i + nx * j];
      const q = Math.round(Math.min(Math.max(d / vmax, 0), 1) * 65535);
      const o = (i + nx * r) * 4;
      out[o] = q >> 8; out[o + 1] = q & 255; out[o + 2] = 0; out[o + 3] = d >= 0.02 ? 255 : 0;
    }
  }
  return out;
}

/** post.velocity_png: R, G = surface u, v; B, A = mid-depth u, v; each (X - 128) * vmax / 127 m/s. */
export function velocityRgba(us: Float32Array, vs: Float32Array, um: Float32Array, vm: Float32Array,
                             nx: number, ny: number, vmax: number): Uint8Array {
  const s = vmax / 127;
  const enc = (a: number) => Math.min(Math.max(Math.round(a / s) + 128, 1), 255);
  const out = new Uint8Array(nx * ny * 4);
  for (let r = 0; r < ny; r++) {
    const j = ny - 1 - r;
    for (let i = 0; i < nx; i++) {
      const c = i + nx * j, o = (i + nx * r) * 4;
      out[o] = enc(us[c]); out[o + 1] = enc(vs[c]); out[o + 2] = enc(um[c]); out[o + 3] = enc(vm[c]);
    }
  }
  return out;
}
