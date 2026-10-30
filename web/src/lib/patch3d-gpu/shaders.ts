// WGSL kernels of the in-browser 3D patch solver (see solver.ts for the method).
// Cells (i, j, k): x east, y north (j = 0 south), z up; cell c = i + nx (j + ny k). MAC faces:
// U[(i, j, k)] at x = i dx (i = 0..nx), V at y = j dy (j = 0..ny), W at z = k dz (k = 0..nz).
// Column (i, j) is solid below kf[i + nx j] and fluid from there up (ground, then any building, is one block).

export const WG = 64;

const COMMON = /* wgsl */ `
struct P {
  nx: u32, ny: u32, nz: u32, ncol: u32,
  dx: f32, dz: f32, g: f32, ucap: f32,
  z0: f32, kappa: f32, sponge_m: f32, sponge_tau: f32,
  bc_dt: f32, bc_nt: u32, perim: u32, eps: f32,
  omega: f32, size_m: f32, zmin: f32, pad: f32,
};
@group(0) @binding(0) var<uniform> p: P;

fn cid(i: u32, j: u32, k: u32) -> u32 { return i + p.nx * (j + p.ny * k); }
fn uid(i: u32, j: u32, k: u32) -> u32 { return i + (p.nx + 1u) * (j + p.ny * k); }
fn vid(i: u32, j: u32, k: u32) -> u32 { return i + p.nx * (j + (p.ny + 1u) * k); }
fn wid(i: u32, j: u32, k: u32) -> u32 { return i + p.nx * (j + p.ny * k); }
fn ring(i: u32, j: u32) -> bool { return i == 0u || j == 0u || i == p.nx - 1u || j == p.ny - 1u; }
fn gidx(g: vec3u) -> u32 { return g.x + g.y * 65535u * ${WG}u; }
fn inband(x: f32, y: f32) -> bool { return min(min(x, p.size_m - x), min(y, p.size_m - y)) < p.sponge_m; }
`;

// clk[0] = step index in the batch, clk[1 + 2 s] = t (s since window start), clk[2 + 2 s] = dt of step s
const CLK = /* wgsl */ `
fn now() -> f32 { return clk[1u + 2u * u32(clk[0])]; }
fn dt() -> f32 { return clk[2u + 2u * u32(clk[0])]; }
`;

/** Ring columns hold the 2D water level (time-interpolated side data), like the OpenFOAM sides. */
export const BOUNDARY = COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> F: array<f32>;
@group(0) @binding(2) var<storage, read> kf: array<u32>;
@group(0) @binding(3) var<storage, read> bc: array<f32>;
@group(0) @binding(4) var<storage, read> clk: array<f32>;
${CLK}
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let c = gidx(g);
  if (c >= p.ncol) { return; }
  let i = c % p.nx; let j = c / p.nx;
  if (!ring(i, j)) { return; }
  var s: u32;  // index along the perimeter: south i, north nx + i, west 2 nx + j, east 2 nx + ny + j
  if (j == 0u) { s = i; } else if (j == p.ny - 1u) { s = p.nx + i; }
  else if (i == 0u) { s = 2u * p.nx + j; } else { s = 2u * p.nx + p.ny + j; }
  let tb = clamp(now() / p.bc_dt, 0.0, f32(p.bc_nt - 1u));
  let t0 = min(u32(floor(tb)), p.bc_nt - 1u); let t1 = min(t0 + 1u, p.bc_nt - 1u); let a = tb - f32(t0);
  let w0 = bc[t0 * p.perim + s]; let w1 = bc[t1 * p.perim + s];
  var wse = -1e30;
  if (w0 > -1e29 && w1 > -1e29) { wse = mix(w0, w1, a); } else if (w0 > -1e29) { wse = w0; } else if (w1 > -1e29) { wse = w1; }
  for (var k = kf[c]; k < p.nz; k++) {
    let zb = p.zmin + f32(k) * p.dz;
    F[cid(i, j, k)] = clamp((wse - zb) / p.dz, 0.0, 1.0);
  }
}
`;

/** Hydrostatic kinematic pressure per cell: g (water above + F^2 dz / 2), the face-mean of a partly filled cell. */
export const HYDRO = COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> F: array<f32>;
@group(0) @binding(2) var<storage, read> kf: array<u32>;
@group(0) @binding(3) var<storage, read_write> Ph: array<f32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let c = gidx(g);
  if (c >= p.ncol) { return; }
  let i = c % p.nx; let j = c / p.nx;
  var above = 0.0;
  for (var kk = p.nz; kk > kf[c]; kk--) {
    let k = kk - 1u;
    let f = F[cid(i, j, k)];
    Ph[cid(i, j, k)] = p.g * (above + f * f * p.dz * 0.5);
    above += f * p.dz;
  }
}
`;

// Velocity at a point (x, y, z in m from the SW-bottom corner of the box) by trilinear interpolation on the MAC grid.
const SAMPLE = /* wgsl */ `
fn lerp3(a000: f32, a100: f32, a010: f32, a110: f32, a001: f32, a101: f32, a011: f32, a111: f32, f: vec3f) -> f32 {
  let x00 = mix(a000, a100, f.x); let x10 = mix(a010, a110, f.x);
  let x01 = mix(a001, a101, f.x); let x11 = mix(a011, a111, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}
fn sU(x: f32, y: f32, z: f32) -> f32 {
  let fi = clamp(x / p.dx, 0.0, f32(p.nx) - 0.001);
  let fj = clamp(y / p.dx - 0.5, 0.0, f32(p.ny - 1u) - 0.001);
  let fk = clamp(z / p.dz - 0.5, 0.0, f32(p.nz - 1u) - 0.001);
  let i = u32(fi); let j = u32(fj); let k = u32(fk);
  let j1 = min(j + 1u, p.ny - 1u); let k1 = min(k + 1u, p.nz - 1u);
  return lerp3(U[uid(i, j, k)], U[uid(i + 1u, j, k)], U[uid(i, j1, k)], U[uid(i + 1u, j1, k)],
               U[uid(i, j, k1)], U[uid(i + 1u, j, k1)], U[uid(i, j1, k1)], U[uid(i + 1u, j1, k1)],
               vec3f(fi - f32(i), fj - f32(j), fk - f32(k)));
}
fn sV(x: f32, y: f32, z: f32) -> f32 {
  let fi = clamp(x / p.dx - 0.5, 0.0, f32(p.nx - 1u) - 0.001);
  let fj = clamp(y / p.dx, 0.0, f32(p.ny) - 0.001);
  let fk = clamp(z / p.dz - 0.5, 0.0, f32(p.nz - 1u) - 0.001);
  let i = u32(fi); let j = u32(fj); let k = u32(fk);
  let i1 = min(i + 1u, p.nx - 1u); let k1 = min(k + 1u, p.nz - 1u);
  return lerp3(V[vid(i, j, k)], V[vid(i1, j, k)], V[vid(i, j + 1u, k)], V[vid(i1, j + 1u, k)],
               V[vid(i, j, k1)], V[vid(i1, j, k1)], V[vid(i, j + 1u, k1)], V[vid(i1, j + 1u, k1)],
               vec3f(fi - f32(i), fj - f32(j), fk - f32(k)));
}
fn sW(x: f32, y: f32, z: f32) -> f32 {
  let fi = clamp(x / p.dx - 0.5, 0.0, f32(p.nx - 1u) - 0.001);
  let fj = clamp(y / p.dx - 0.5, 0.0, f32(p.ny - 1u) - 0.001);
  let fk = clamp(z / p.dz, 0.0, f32(p.nz) - 0.001);
  let i = u32(fi); let j = u32(fj); let k = u32(fk);
  let i1 = min(i + 1u, p.nx - 1u); let j1 = min(j + 1u, p.ny - 1u);
  return lerp3(W[wid(i, j, k)], W[wid(i1, j, k)], W[wid(i, j1, k)], W[wid(i1, j1, k)],
               W[wid(i, j, k + 1u)], W[wid(i1, j, k + 1u)], W[wid(i, j1, k + 1u)], W[wid(i1, j1, k + 1u)],
               vec3f(fi - f32(i), fj - f32(j), fk - f32(k)));
}
fn fluid(i: u32, j: u32, k: u32) -> bool { return k >= kf[i + p.nx * j] && k < p.nz; }
`;

const ADVECT_HEAD = COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> U: array<f32>;
@group(0) @binding(2) var<storage, read> V: array<f32>;
@group(0) @binding(3) var<storage, read> W: array<f32>;
@group(0) @binding(4) var<storage, read> F: array<f32>;
@group(0) @binding(5) var<storage, read> kf: array<u32>;
@group(0) @binding(6) var<storage, read> Ph: array<f32>;
@group(0) @binding(7) var<storage, read> clk: array<f32>;
@group(0) @binding(8) var<storage, read_write> O: array<f32>;
${CLK}
${SAMPLE}
`;

/** Semi-Lagrangian advection of U plus the hydrostatic pressure gradient. Faces with no water on either side,
 * next to a solid, or on the box edge (the ring cells are the reservoir) carry no velocity. */
export const ADVECT_U = ADVECT_HEAD + /* wgsl */ `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let n = gidx(g);
  if (n >= (p.nx + 1u) * p.ny * p.nz) { return; }
  let i = n % (p.nx + 1u); let j = (n / (p.nx + 1u)) % p.ny; let k = n / ((p.nx + 1u) * p.ny);
  if (i == 0u || i == p.nx || !fluid(i - 1u, j, k) || !fluid(i, j, k)) { O[n] = 0.0; return; }
  let fl = F[cid(i - 1u, j, k)]; let fr = F[cid(i, j, k)];
  if (max(fl, fr) < p.eps) { O[n] = 0.0; return; }
  let x = f32(i) * p.dx; let y = (f32(j) + 0.5) * p.dx; let z = (f32(k) + 0.5) * p.dz;
  let h = dt();
  let u0 = U[n];
  let v0 = 0.25 * (V[vid(i - 1u, j, k)] + V[vid(i, j, k)] + V[vid(i - 1u, j + 1u, k)] + V[vid(i, j + 1u, k)]);
  let w0 = 0.25 * (W[wid(i - 1u, j, k)] + W[wid(i, j, k)] + W[wid(i - 1u, j, k + 1u)] + W[wid(i, j, k + 1u)]);
  var u = sU(x - h * u0, y - h * v0, z - h * w0);
  u -= h * (Ph[cid(i, j, k)] - Ph[cid(i - 1u, j, k)]) / p.dx;
  let cap = min(p.ucap, 0.45 * p.dx / h);
  O[n] = clamp(u, -cap, cap);
}
`;

export const ADVECT_V = ADVECT_HEAD + /* wgsl */ `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let n = gidx(g);
  if (n >= p.nx * (p.ny + 1u) * p.nz) { return; }
  let i = n % p.nx; let j = (n / p.nx) % (p.ny + 1u); let k = n / (p.nx * (p.ny + 1u));
  if (j == 0u || j == p.ny || !fluid(i, j - 1u, k) || !fluid(i, j, k)) { O[n] = 0.0; return; }
  let fl = F[cid(i, j - 1u, k)]; let fr = F[cid(i, j, k)];
  if (max(fl, fr) < p.eps) { O[n] = 0.0; return; }
  let x = (f32(i) + 0.5) * p.dx; let y = f32(j) * p.dx; let z = (f32(k) + 0.5) * p.dz;
  let h = dt();
  let v0 = V[n];
  let u0 = 0.25 * (U[uid(i, j - 1u, k)] + U[uid(i + 1u, j - 1u, k)] + U[uid(i, j, k)] + U[uid(i + 1u, j, k)]);
  let w0 = 0.25 * (W[wid(i, j - 1u, k)] + W[wid(i, j, k)] + W[wid(i, j - 1u, k + 1u)] + W[wid(i, j, k + 1u)]);
  var v = sV(x - h * u0, y - h * v0, z - h * w0);
  v -= h * (Ph[cid(i, j, k)] - Ph[cid(i, j - 1u, k)]) / p.dx;
  let cap = min(p.ucap, 0.45 * p.dx / h);
  O[n] = clamp(v, -cap, cap);
}
`;

/** W: advection only (the hydrostatic part balances gravity); the non-hydrostatic pressure acts in the projection.
 * The sponge band damps W directly. */
export const ADVECT_W = ADVECT_HEAD + /* wgsl */ `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let n = gidx(g);
  if (n >= p.nx * p.ny * (p.nz + 1u)) { return; }
  let i = n % p.nx; let j = (n / p.nx) % p.ny; let k = n / (p.nx * p.ny);
  if (k == 0u || k == p.nz || !fluid(i, j, k - 1u) || !fluid(i, j, k)) { O[n] = 0.0; return; }
  let fl = F[cid(i, j, k - 1u)]; let fr = F[cid(i, j, k)];
  if (max(fl, fr) < p.eps) { O[n] = 0.0; return; }
  let x = (f32(i) + 0.5) * p.dx; let y = (f32(j) + 0.5) * p.dx; let z = f32(k) * p.dz;
  let h = dt();
  let w0 = W[n];
  let u0 = 0.25 * (U[uid(i, j, k - 1u)] + U[uid(i + 1u, j, k - 1u)] + U[uid(i, j, k)] + U[uid(i + 1u, j, k)]);
  let v0 = 0.25 * (V[vid(i, j, k - 1u)] + V[vid(i, j + 1u, k - 1u)] + V[vid(i, j, k)] + V[vid(i, j + 1u, k)]);
  var w = sW(x - h * u0, y - h * v0, z - h * w0);
  if (inband(x, y)) { w /= 1.0 + h / p.sponge_tau; }
  let cap = 0.45 * p.dz / h;
  O[n] = clamp(w, -cap, cap);
}
`;

/** Vertical mixing (parabolic eddy viscosity from a log-law bed friction velocity), bed and wall drag (rough-wall
 * log law, ks as the OpenFOAM patch), and the side sponge, implicit in each face column (Thomas). DIR 0 = U, 1 = V. */
export const MIX = COMMON + /* wgsl */ `
override DIR: u32 = 0u;
@group(0) @binding(1) var<storage, read_write> O: array<f32>;
@group(0) @binding(2) var<storage, read> F: array<f32>;
@group(0) @binding(3) var<storage, read> kf: array<u32>;
@group(0) @binding(4) var<storage, read_write> S: array<f32>;
@group(0) @binding(5) var<storage, read> clk: array<f32>;
${CLK}
fn fid(a: u32, b: u32, k: u32) -> u32 { if (DIR == 0u) { return uid(a, b, k); } return vid(a, b, k); }
fn solidc(i: i32, j: i32, k: u32) -> bool {
  if (i < 0 || j < 0 || i >= i32(p.nx) || j >= i32(p.ny)) { return false; }
  return k < kf[u32(i) + p.nx * u32(j)];
}
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let n = gidx(g);
  var na: u32; var nb: u32;
  if (DIR == 0u) { na = p.nx + 1u; nb = p.ny; } else { na = p.nx; nb = p.ny + 1u; }
  if (n >= na * nb) { return; }
  let a = n % na; let b = n / na;
  // the two cells either side of the face column
  var il: u32; var jl: u32; var ir: u32; var jr: u32;
  if (DIR == 0u) { if (a == 0u || a == p.nx) { return; } il = a - 1u; jl = b; ir = a; jr = b; }
  else { if (b == 0u || b == p.ny) { return; } il = a; jl = b - 1u; ir = a; jr = b; }
  let kb = max(kf[il + p.nx * jl], kf[ir + p.nx * jr]);
  if (kb >= p.nz) { return; }
  let h = dt();
  var x: f32; var y: f32;
  if (DIR == 0u) { x = f32(a) * p.dx; y = (f32(b) + 0.5) * p.dx; } else { x = (f32(a) + 0.5) * p.dx; y = f32(b) * p.dx; }
  let damp = select(0.0, h / p.sponge_tau, inband(x, y));
  var depth = 0.0; var kt = kb;
  for (var k = kb; k < p.nz; k++) {
    let f = 0.5 * (F[cid(il, jl, k)] + F[cid(ir, jr, k)]);
    depth += f * p.dz;
    if (f > p.eps) { kt = k; }
  }
  if (depth < 1e-3) {
    for (var k = kb; k < p.nz; k++) { O[fid(a, b, k)] /= 1.0 + damp; }
    return;
  }
  // log law at the first face above the bed: Cf = (kappa / ln(z1 / z0))^2
  let z1 = max(0.5 * min(p.dz, depth), 2.0 * p.z0);
  let cf = min(pow(p.kappa / log(z1 / p.z0), 2.0), 0.05);
  let zw = max(0.5 * p.dx, 2.0 * p.z0);
  let cfw = min(pow(p.kappa / log(zw / p.z0), 2.0), 0.05);
  let ub = abs(O[fid(a, b, kb)]);
  let ustar = sqrt(cf) * ub;
  // Thomas: -lo u[k-1] + di u[k] - up u[k+1] = rhs; S holds the modified upper coefficients
  var cprev = 0.0; var dprev = 0.0;
  for (var k = kb; k <= kt; k++) {
    let zlo = f32(k - kb) * p.dz; let zup = zlo + p.dz;
    var lo = 0.0; var up = 0.0;
    if (k > kb) { lo = h * max(p.kappa * ustar * zlo * (1.0 - zlo / depth), 1e-6) / (p.dz * p.dz); }
    if (k < kt) { up = h * max(p.kappa * ustar * zup * (1.0 - min(zup / depth, 1.0)), 1e-6) / (p.dz * p.dz); }
    let uo = O[fid(a, b, k)];
    var drag = damp;
    if (k == kb) { drag += h * cf * abs(uo) / min(p.dz, depth); }
    // a wall parallel to the flow beside this face (solid cell across the face, either side)
    var wall = false;
    if (DIR == 0u) {
      wall = solidc(i32(il), i32(jl) - 1, k) || solidc(i32(il), i32(jl) + 1, k) || solidc(i32(ir), i32(jr) - 1, k) || solidc(i32(ir), i32(jr) + 1, k);
    } else {
      wall = solidc(i32(il) - 1, i32(jl), k) || solidc(i32(il) + 1, i32(jl), k) || solidc(i32(ir) - 1, i32(jr), k) || solidc(i32(ir) + 1, i32(jr), k);
    }
    if (wall) { drag += h * cfw * abs(uo) / p.dx; }
    let di = 1.0 + lo + up + drag - lo * cprev;
    let c = up / di;
    let d = (uo + lo * dprev) / di;
    S[fid(a, b, k)] = c;
    O[fid(a, b, k)] = d;
    cprev = c; dprev = d;
  }
  for (var kk = kt; kk > kb; kk--) {
    let k = kk - 1u;
    O[fid(a, b, k)] = O[fid(a, b, k)] + S[fid(a, b, k)] * O[fid(a, b, k + 1u)];
  }
  for (var k = kt + 1u; k < p.nz; k++) { O[fid(a, b, k)] /= 1.0 + damp; }
}
`;

/** Non-hydrostatic pressure q (kinematic): red-black vertical-line SOR on the liquid cells (F >= 0.5) for
 * lap(q) = div(u*) / dt; q = 0 in air and in the ring (Dirichlet), no flux through solids. PARITY picks the
 * columns. Lines (Thomas in z) handle the 8:1 cell aspect exactly; q is warm-started from the last step.
 * S[0..ncell) holds the sweep coefficients, S[ncell + c] the previous iterate. */
export const PRESSURE = COMMON + /* wgsl */ `
override PARITY: u32 = 0u;
@group(0) @binding(1) var<storage, read_write> Q: array<f32>;
@group(0) @binding(2) var<storage, read> U: array<f32>;
@group(0) @binding(3) var<storage, read> V: array<f32>;
@group(0) @binding(4) var<storage, read> W: array<f32>;
@group(0) @binding(5) var<storage, read> F: array<f32>;
@group(0) @binding(6) var<storage, read> kf: array<u32>;
@group(0) @binding(7) var<storage, read_write> S: array<f32>;
@group(0) @binding(8) var<storage, read> clk: array<f32>;
${CLK}
fn liquid(i: u32, j: u32, k: u32) -> bool {
  return !ring(i, j) && k >= kf[i + p.nx * j] && k < p.nz && F[cid(i, j, k)] >= 0.5;
}
fn open(i: u32, j: u32, k: u32) -> bool { return k >= kf[i + p.nx * j] && k < p.nz; }
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let c = gidx(g);
  if (c >= p.ncol) { return; }
  let i = c % p.nx; let j = c / p.nx;
  if (((i + j) & 1u) != PARITY) { return; }
  let k0 = kf[c];
  if (ring(i, j)) { for (var k = k0; k < p.nz; k++) { Q[cid(i, j, k)] = 0.0; } return; }
  let nc = p.nx * p.ny * p.nz;
  let h = dt();
  let ax = 1.0 / (p.dx * p.dx); let az = 1.0 / (p.dz * p.dz);
  var cprev = 0.0; var dprev = 0.0;
  for (var k = k0; k < p.nz; k++) {
    let me = cid(i, j, k);
    S[nc + me] = Q[me];
    if (!liquid(i, j, k)) { S[me] = 0.0; Q[me] = 0.0; S[nc + me] = 0.0; cprev = 0.0; dprev = 0.0; continue; }
    let dv = (U[uid(i + 1u, j, k)] - U[uid(i, j, k)]) / p.dx + (V[vid(i, j + 1u, k)] - V[vid(i, j, k)]) / p.dx
           + (W[wid(i, j, k + 1u)] - W[wid(i, j, k)]) / p.dz;
    var di = 0.0; var rhs = -dv / h;
    // horizontal neighbours: i, j are interior here (ring columns returned above)
    if (open(i - 1u, j, k)) { di += ax; if (liquid(i - 1u, j, k)) { rhs += ax * Q[cid(i - 1u, j, k)]; } }
    if (open(i + 1u, j, k)) { di += ax; if (liquid(i + 1u, j, k)) { rhs += ax * Q[cid(i + 1u, j, k)]; } }
    if (open(i, j - 1u, k)) { di += ax; if (liquid(i, j - 1u, k)) { rhs += ax * Q[cid(i, j - 1u, k)]; } }
    if (open(i, j + 1u, k)) { di += ax; if (liquid(i, j + 1u, k)) { rhs += ax * Q[cid(i, j + 1u, k)]; } }
    var lo = 0.0; var up = 0.0;
    if (k > k0) { di += az; if (liquid(i, j, k - 1u)) { lo = az; } }
    if (k + 1u < p.nz) { di += az; if (liquid(i, j, k + 1u)) { up = az; } }
    let den = di - lo * cprev;
    cprev = up / den;
    dprev = (rhs + lo * dprev) / den;
    S[me] = cprev;
    Q[me] = dprev;
  }
  var qn = 0.0;
  for (var kk = p.nz; kk > k0; kk--) {
    let me = cid(i, j, kk - 1u);
    let ql = Q[me] + S[me] * qn;
    qn = ql;
    let qo = S[nc + me];
    Q[me] = qo + p.omega * (ql - qo);
  }
}
`;

/** Pressure correction u -= dt grad(q) on faces with liquid on either side (q = 0 in air). DIR 0 U, 1 V, 2 W. */
export const CORRECT = COMMON + /* wgsl */ `
override DIR: u32 = 0u;
@group(0) @binding(1) var<storage, read_write> O: array<f32>;
@group(0) @binding(2) var<storage, read> Q: array<f32>;
@group(0) @binding(3) var<storage, read> F: array<f32>;
@group(0) @binding(4) var<storage, read> kf: array<u32>;
@group(0) @binding(5) var<storage, read> clk: array<f32>;
${CLK}
fn open(i: u32, j: u32, k: u32) -> bool { return k >= kf[i + p.nx * j] && k < p.nz; }
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let n = gidx(g);
  var i: u32; var j: u32; var k: u32; var a: u32; var b: u32; var h: f32;
  if (DIR == 0u) {
    if (n >= (p.nx + 1u) * p.ny * p.nz) { return; }
    i = n % (p.nx + 1u); j = (n / (p.nx + 1u)) % p.ny; k = n / ((p.nx + 1u) * p.ny);
    if (i == 0u || i == p.nx) { return; }
    a = cid(i - 1u, j, k); b = cid(i, j, k); h = p.dx;
    if (!open(i - 1u, j, k) || !open(i, j, k)) { return; }
  } else if (DIR == 1u) {
    if (n >= p.nx * (p.ny + 1u) * p.nz) { return; }
    i = n % p.nx; j = (n / p.nx) % (p.ny + 1u); k = n / (p.nx * (p.ny + 1u));
    if (j == 0u || j == p.ny) { return; }
    a = cid(i, j - 1u, k); b = cid(i, j, k); h = p.dx;
    if (!open(i, j - 1u, k) || !open(i, j, k)) { return; }
  } else {
    if (n >= p.nx * p.ny * (p.nz + 1u)) { return; }
    i = n % p.nx; j = (n / p.nx) % p.ny; k = n / (p.nx * p.ny);
    if (k == 0u || k == p.nz) { return; }
    a = cid(i, j, k - 1u); b = cid(i, j, k); h = p.dz;
    if (!open(i, j, k - 1u) || !open(i, j, k)) { return; }
  }
  if (max(F[a], F[b]) < 0.5) { return; }
  O[n] = O[n] - dt() * (Q[b] - Q[a]) / h;
}
`;

/** One direction of the conservative, bounded split VOF advection of Weymouth & Yue (2010):
 * F' = F - dt d(uF)/dx + dt c du/dx, c = [F0 > 0.5] from the start of the step; first-order upwind fluxes. */
export const VOF = COMMON + /* wgsl */ `
override DIR: u32 = 0u;
@group(0) @binding(1) var<storage, read> Fi: array<f32>;
@group(0) @binding(2) var<storage, read_write> Fo: array<f32>;
@group(0) @binding(3) var<storage, read> F0: array<f32>;
@group(0) @binding(4) var<storage, read> Uf: array<f32>;
@group(0) @binding(5) var<storage, read> kf: array<u32>;
@group(0) @binding(6) var<storage, read> clk: array<f32>;
${CLK}
fn flux(u: f32, fl: f32, fr: f32) -> f32 { return select(u * fr, u * fl, u > 0.0); }
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let c = gidx(g);
  if (c >= p.nx * p.ny * p.nz) { return; }
  let i = c % p.nx; let j = (c / p.nx) % p.ny; let k = c / (p.nx * p.ny);
  let f = Fi[c];
  if (k < kf[i + p.nx * j]) { Fo[c] = 0.0; return; }
  var ul: f32; var ur: f32; var fl = 0.0; var fr = 0.0; var h: f32;
  if (DIR == 0u) {
    ul = Uf[uid(i, j, k)]; ur = Uf[uid(i + 1u, j, k)]; h = p.dx;
    if (i > 0u) { fl = Fi[cid(i - 1u, j, k)]; } if (i + 1u < p.nx) { fr = Fi[cid(i + 1u, j, k)]; }
  } else if (DIR == 1u) {
    ul = Uf[vid(i, j, k)]; ur = Uf[vid(i, j + 1u, k)]; h = p.dx;
    if (j > 0u) { fl = Fi[cid(i, j - 1u, k)]; } if (j + 1u < p.ny) { fr = Fi[cid(i, j + 1u, k)]; }
  } else {
    ul = Uf[wid(i, j, k)]; ur = Uf[wid(i, j, k + 1u)]; h = p.dz;
    if (k > 0u) { fl = Fi[cid(i, j, k - 1u)]; } if (k + 1u < p.nz) { fr = Fi[cid(i, j, k + 1u)]; }
  }
  let r = dt() / h;
  let cc = select(0.0, 1.0, F0[c] > 0.5);
  Fo[c] = clamp(f - r * (flux(ur, f, fr) - flux(ul, fl, f)) + r * cc * (ur - ul), 0.0, 1.0);
}
`;

/** Restack each column's water from its floor up, keeping its total exactly: the free surface is single-valued in
 * each column (no overturning, as in layered non-hydrostatic flood models). Without it a film pushed up a terrain
 * step into an empty cell hovers there (gravity acts through the column pressure), and numerical diffusion leaves
 * traces of water above the waterline. */
export const STACK = COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> F: array<f32>;
@group(0) @binding(2) var<storage, read> kf: array<u32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let c = gidx(g);
  if (c >= p.ncol) { return; }
  let i = c % p.nx; let j = c / p.nx;
  var total = 0.0;
  for (var k = kf[c]; k < p.nz; k++) { total += F[cid(i, j, k)]; }
  for (var k = kf[c]; k < p.nz; k++) { F[cid(i, j, k)] = clamp(total - f32(k - kf[c]), 0.0, 1.0); }
}
`;

/** Advance the batch clock (one thread). */
export const TICK = COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> clk: array<f32>;
@compute @workgroup_size(1) fn main() { if (p.nx > 0u) { clk[0] = clk[0] + 1.0; } }
`;

/** Largest |u|, |v| (stats[0]) and |w| (stats[1]) as float bits (non-negative floats order like u32). */
export const STATS = COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> U: array<f32>;
@group(0) @binding(2) var<storage, read> V: array<f32>;
@group(0) @binding(3) var<storage, read> W: array<f32>;
@group(0) @binding(4) var<storage, read_write> st: array<atomic<u32>>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let n = gidx(g);
  if (n < (p.nx + 1u) * p.ny * p.nz) { atomicMax(&st[0], bitcast<u32>(abs(U[n]))); }
  if (n < p.nx * (p.ny + 1u) * p.nz) { atomicMax(&st[0], bitcast<u32>(abs(V[n]))); }
  if (n < p.nx * p.ny * (p.nz + 1u)) { atomicMax(&st[1], bitcast<u32>(abs(W[n]))); }
}
`;

/** Per column, for the frame: depth above the floor, surface and mid-depth (u, v) (as dryrun/patch3d/post.frame),
 * and the horizontal pressure force this column's water puts on each neighbouring solid column (E, W, N, S),
 * per metre of wall width... times dx: N. Pressure = rho (Ph + Q), gauge. 9 floats per column. */
export const FRAME = COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> F: array<f32>;
@group(0) @binding(2) var<storage, read> U: array<f32>;
@group(0) @binding(3) var<storage, read> V: array<f32>;
@group(0) @binding(4) var<storage, read> kf: array<u32>;
@group(0) @binding(5) var<storage, read> Ph: array<f32>;
@group(0) @binding(6) var<storage, read> Q: array<f32>;
@group(0) @binding(7) var<storage, read_write> out: array<f32>;
fn kfl(i: i32, j: i32) -> u32 {
  if (i < 0 || j < 0 || i >= i32(p.nx) || j >= i32(p.ny)) { return 0u; }
  return kf[u32(i) + p.nx * u32(j)];
}
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let c = gidx(g);
  if (c >= p.ncol) { return; }
  let i = c % p.nx; let j = c / p.nx;
  let k0 = kf[c];
  var depth = 0.0; var top = -1;
  for (var k = k0; k < p.nz; k++) {
    let f = F[cid(i, j, k)];
    depth += f * p.dz;
    if (f >= 0.5) { top = i32(k); }
  }
  var o: array<f32, 9>;
  o[0] = depth;
  if (top >= 0) {
    let kt = u32(top); let km = (k0 + kt) / 2u;
    o[1] = 0.5 * (U[uid(i, j, kt)] + U[uid(i + 1u, j, kt)]); o[2] = 0.5 * (V[vid(i, j, kt)] + V[vid(i, j + 1u, kt)]);
    o[3] = 0.5 * (U[uid(i, j, km)] + U[uid(i + 1u, j, km)]); o[4] = 0.5 * (V[vid(i, j, km)] + V[vid(i, j + 1u, km)]);
  }
  // wall faces: this column's fluid cells k >= k0 that face a neighbour's solid cells (k < kf[nb])
  let ii = i32(i); let jj = i32(j);
  let nbk = array<u32, 4>(kfl(ii + 1, jj), kfl(ii - 1, jj), kfl(ii, jj + 1), kfl(ii, jj - 1));
  for (var s = 0u; s < 4u; s++) {
    var f = 0.0;
    for (var k = k0; k < min(nbk[s], p.nz); k++) {
      let me = cid(i, j, k);
      f += 1000.0 * max(Ph[me] + Q[me], 0.0) * p.dz * p.dx;
    }
    o[5u + s] = f;
  }
  for (var s = 0u; s < 9u; s++) { out[9u * c + s] = o[s]; }
}
`;
