// Writes .br and .gz next to every compressible file in dist/, so the API serves them without compressing per request
// (dryrun/api/static.py picks one by Accept-Encoding). A variant that is not smaller is not written.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = process.argv[2] ?? "dist";
const TYPES = /\.(js|mjs|css|html|json|geojson|svg|wasm|xml|txt|glsl|map|czml|gltf|b3dm|ktx2)$/i;
const MIN_BYTES = 1024;

let raw = 0, br = 0, gz = 0, files = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!TYPES.test(name)) continue;
    const buf = readFileSync(p);
    if (buf.length < MIN_BYTES) continue;
    const b = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
    const g = gzipSync(buf, { level: 9 });
    if (b.length < buf.length) writeFileSync(p + ".br", b);
    if (g.length < buf.length) writeFileSync(p + ".gz", g);
    raw += buf.length; br += Math.min(b.length, buf.length); gz += Math.min(g.length, buf.length); files++;
  }
}
walk(ROOT);
const mb = (n) => (n / 1e6).toFixed(2) + " MB";
console.log(`precompress: ${files} files, ${mb(raw)} raw -> ${mb(gz)} gzip, ${mb(br)} brotli`);
