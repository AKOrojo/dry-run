// Layers tab, "3D on your GPU" (design board 9): solve a 3D close-up box on the viewer's own GPU (WebGPU, in the
// browser) for the run on the map, and open it in the existing 3D close-up viewer.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Crosshair, Cube, GraphicsCard, Info, Stop } from "@phosphor-icons/react";
import type { AOIManifest, RunManifest } from "../lib/api";
import { API } from "../lib/api";
import {
  GpuError, dimsFor, fits, gpuAvailable, gpuLimits, largestBox, patchDims, solvePatchInBrowser,
} from "../lib/patch3d-gpu";
import type { PatchDims } from "../lib/patch3d-gpu";
import { abortSolve, boxCentre, setGpuBox, setSolveController, useGpuBox } from "../lib/gpubox";
import { assemblePatch, setCloseUp } from "../lib/patch3d";
import type { PatchRow } from "../lib/patch3d";
import { Card, FIG, raisedButton, Segmented } from "./rev5";
import { Slider } from "./RainCards";

const MEM_KEY = "dr_gpu_mb";
const CELLS = [0.5, 1, 2, 4];
const FRAME_S = 30;
const REF_S_PER_FRAME = 0.9;  // measured by Eng A on an RX 6800, 200 m box at 1 m cells

const readMb = (): number => {
  try {
    const v = Number(localStorage.getItem(MEM_KEY));
    if (Number.isFinite(v) && v >= 512 && v <= 8192) return Math.round(v / 512) * 512;
  } catch { /* storage unavailable */ }
  return 1024;
};
const saveMb = (v: number) => { try { localStorage.setItem(MEM_KEY, String(v)); } catch { /* storage unavailable */ } };

const mbText = (mb: number) => (mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
const bytesText = (b: number) => (b >= 2 ** 30 ? `${+(b / 2 ** 30).toFixed(1)} GB` : `${Math.round(b / 2 ** 20)} MB`);
const clock = (s: number) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const dur = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);

const ERRORS: Record<string, string> = {
  "too-large": "Too big for that memory: try a smaller box or coarser cells.",
  "device-lost": "The GPU reset during the solve. Try a smaller box or coarser cells.",
  "no-webgpu": "WebGPU is not available in this browser.",
  "inputs": "Could not fetch the 3D inputs for this run.",
};

const muted: CSSProperties = { margin: 0, color: "var(--ink-muted)", fontSize: 12, lineHeight: "16px" };
const btn: CSSProperties = { height: 32, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "0 12px",
  borderRadius: "var(--radius-md)", font: "inherit", fontSize: 13, whiteSpace: "nowrap", cursor: "pointer" };
const icon = { size: 15, weight: "bold" as const, "aria-hidden": true, style: { flex: "none" } };

/** Solve in the browser and open the result in the close-up viewer. The state lives in lib/gpubox. */
async function runSolve(runId: string, buildingsUrl: string | undefined, centre: [number, number], size: number, cell: number, memoryMb: number) {
  const ctl = new AbortController();
  setSolveController(ctl);
  const startedAt = Date.now();
  setGpuBox({ run: { phase: "inputs", fraction: 0, startedAt }, error: null });
  try {
    const r = await solvePatchInBrowser(API, runId, centre, size, cell, {
      memoryMb, signal: ctl.signal,
      onProgress: (p) => setGpuBox({ run: { phase: p.phase, fraction: p.fraction ?? (p.phase === "encoding" ? 1 : 0), startedAt } }),
    });
    if (ctl.signal.aborted) { r.release(); return; }
    const row: PatchRow = {
      patch_id: r.manifest.patch_id, status: "done", center: centre, size_m: size, cell_m: cell,
      bounds_wgs84: r.manifest.bounds_wgs84, t_window_s: r.manifest.t_window_s, label: `Your GPU · ${size} m`,
    };
    const data = await assemblePatch(row, r.manifest, r.forces, r.frames, buildingsUrl);
    if (ctl.signal.aborted) { r.release(); return; }
    setCloseUp({ active: row.patch_id, status: "loading", data: null, local: { data, release: r.release } });
  } catch (e) {
    if (ctl.signal.aborted || (e as { name?: string })?.name === "AbortError") return;
    const kind = e instanceof GpuError ? e.kind : "inputs";
    setGpuBox({ error: ERRORS[kind] ?? ERRORS.inputs });
  } finally {
    setSolveController(null);
    setGpuBox({ run: null });
  }
}

export function GpuCard({ run, aoi, buildingsUrl }: { run?: RunManifest; aoi?: AOIManifest; buildingsUrl?: string }) {
  const box = useGpuBox();
  const runId = run?.status === "done" ? run.run_id : undefined;
  const bounds = aoi?.grid.bounds_wgs84 ?? null;
  const [limits, setLimits] = useState<{ maxBuffer: number; description: string } | null | undefined>(undefined);
  const [memoryMb, setMemoryMb] = useState(readMb);
  const [dims, setDims] = useState<PatchDims | null>(null);
  const [dimsErr, setDimsErr] = useState(false);
  const [now, setNow] = useState(Date.now());
  const webgpu = gpuAvailable();
  const running = !!box.run;

  useEffect(() => {
    if (!webgpu) { setLimits(null); return; }
    let off = false;
    gpuLimits().then((l) => { if (!off) setLimits(l); }, () => { if (!off) setLimits(null); });
    return () => { off = true; };
  }, [webgpu]);
  useEffect(() => { setGpuBox({ bounds, shown: !!runId }); }, [bounds, runId]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const centre = boxCentre(box);
  const span = dims?.span_m ?? 4;
  const maxBuffer = limits?.maxBuffer ?? Infinity;
  const largest = useMemo(() => largestBox(box.cell_m, span, memoryMb, maxBuffer), [box.cell_m, span, memoryMb, maxBuffer]);
  const sizeMax = Math.max(70, largest ?? 0);
  const size = Math.min(Math.max(60, box.size_m), largest ?? 60);
  useEffect(() => { if (size !== box.size_m) setGpuBox({ size_m: size }); }, [size, box.size_m]);

  // The grid of the box, from the server before any download; debounced 400 ms while the box moves.
  const cx = centre?.[0], cy = centre?.[1];
  useEffect(() => {
    if (!runId || cx == null || cy == null || !limits) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      patchDims(API, runId, [cx, cy], size, box.cell_m, ctl.signal).then((d) => { setDims(d); setDimsErr(false); }, () => { if (!ctl.signal.aborted) setDimsErr(true); });
    }, 400);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [runId, cx, cy, size, box.cell_m, limits]);

  const fit = dims ? fits(dims, memoryMb, maxBuffer) : null;
  const cells = dims?.cells ?? Math.round(size / box.cell_m) ** 2 * dimsFor(size, box.cell_m, span).nz;
  const window_s = dims ? dims.t_window_s[1] - dims.t_window_s[0] : null;
  const refCells = (() => { const d = dimsFor(200, 1, span); return d.nx * d.ny * d.nz; })();
  const estS = window_s != null ? REF_S_PER_FRAME * (cells / refCells) * (window_s / FRAME_S) : null;
  const canRun = !!runId && !!limits && !!dims && !dimsErr && !!fit?.fits && !!centre;

  const elapsed = box.run ? (now - box.run.startedAt) / 1000 : 0;
  const frac = box.run?.phase === "solving" ? box.run.fraction : 0;
  const eta = frac > 0.01 ? elapsed / frac - elapsed : null;
  const phaseText = box.run?.phase === "inputs" ? "Fetching inputs" : box.run?.phase === "encoding" ? "Encoding frames" : "Solving";

  const start = () => { if (canRun && centre) void runSolve(runId!, buildingsUrl, centre, size, box.cell_m, memoryMb); };
  const rows: [string, string][] = [
    ["Box", `${size} × ${size} m · ${box.cell_m} m cells · ${cells.toLocaleString("en-US")} cells`],
    ["Time window", window_s != null ? `${Math.round(window_s / 60)} min around the peak` : "…"],
    ["Estimated time", running
      ? (eta != null ? `about ${dur(eta)} left` : "estimating…")
      : estS != null ? `about ${Math.max(1, Math.round(estS / 60))} min on a fast desktop GPU` : "…"],
  ];

  return (
    <div data-tour="gpu3d" style={{ display: "flex", flexDirection: "column" }}>
      <Card title="3D on your GPU" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>WebGPU</span>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 14px 14px", fontSize: 13, lineHeight: "18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <GraphicsCard size={18} weight="bold" color="var(--ink)" aria-hidden="true" style={{ flex: "none" }} />
            {limits ? (
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{limits.description || "GPU adapter"}</span>
                <span style={{ color: "var(--ink-muted)", fontSize: 12 }}>WebGPU available · up to {bytesText(limits.maxBuffer)} per buffer</span>
              </span>
            ) : (
              <span style={{ fontWeight: 600 }}>{limits === undefined ? "Checking the GPU" : "WebGPU is not available in this browser"}</span>
            )}
          </div>
          {limits === null && <p style={muted}>The demo boxes still open from the cached OpenFOAM result in 3D close-ups.</p>}
          {limits && (
            <>
              {!runId && <p style={muted}>Load or simulate a run first.</p>}
              <div {...(!runId || running ? { inert: "" } : {})} style={{ display: "flex", flexDirection: "column", gap: 12, opacity: !runId ? 0.5 : 1 }}>
                <Slider label="GPU memory it may use" value={memoryMb} min={512} max={8192} step={512} text={mbText(memoryMb)} lo="512 MB" hi="8 GB"
                  onChange={(v) => { setMemoryMb(v); saveMb(v); }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ color: "var(--ink-muted)" }}>Cell size</span>
                  <Segmented<string> options={CELLS.map((c) => ({ value: String(c), label: `${c} m` }))} active={String(box.cell_m)} onChange={(v) => setGpuBox({ cell_m: Number(v) })} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <Slider label="Box size" value={size} min={60} max={sizeMax} step={10} text={`${size} m`} lo="60 m" hi={`${sizeMax} m`}
                    onChange={(v) => setGpuBox({ size_m: Math.min(v, largest ?? 60) })} />
                  <span style={muted}>{largest != null ? `Up to ${largest} m at this memory and cell size` : "No box fits at this memory and cell size"}</span>
                </div>
              </div>
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", rowGap: 7, columnGap: 10, lineHeight: "18px" }}>
                {rows.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt style={{ color: "var(--ink-muted)" }}>{k}</dt><dd style={{ margin: 0, fontWeight: 600, textAlign: "right", ...FIG }}>{v}</dd></div>)}
              </dl>
              {runId && fit && !fit.fits && <p style={{ ...muted, color: "var(--hazard)" }}>{fit.reason}: needs {fit.need_mb} MB of {fit.budget_mb} MB.</p>}
              {runId && dimsErr && <p style={{ ...muted, color: "var(--hazard)" }}>Could not read the 3D inputs for this run.</p>}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", background: "var(--ground)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", fontSize: 12, lineHeight: "16px" }}>
                <Info size={16} weight="bold" aria-hidden="true" style={{ flex: "none", marginTop: 0 }} />
                <span>Runs on your GPU in this browser. Nothing is uploaded. More memory allows a bigger box or finer cells. Demo boxes use the cached OpenFOAM result.</span>
              </div>
              {box.error && <p role="alert" style={{ margin: 0, color: "var(--hazard)", fontSize: 12, lineHeight: "16px" }}>{box.error}</p>}
              {running ? (
                <div role="status" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{phaseText}</span>
                  <span role="progressbar" aria-label="3D solve progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}
                    style={{ position: "relative", display: "block", height: 8, borderRadius: "var(--radius-pill)", background: "var(--ground)", boxShadow: "var(--inset-shadow)", overflow: "hidden" }}>
                    <span style={{ position: "absolute", inset: `0 ${(100 - Math.min(1, Math.max(0, frac)) * 100).toFixed(1)}% 0 0`, background: "var(--depth-3)", borderRadius: "var(--radius-pill)", transition: "inset 0.8s linear" }} />
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-muted)", fontSize: 12, ...FIG }}>
                    <span>{clock(elapsed)} · {eta != null ? `about ${dur(eta)} left` : "estimating"}</span>
                    <span style={{ marginLeft: "auto" }}>
                      <button type="button" onClick={abortSolve} style={{ ...btn, ...raisedButton, fontWeight: 500 }}><Stop {...icon} />Stop</button>
                    </span>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button type="button" disabled={!canRun} onClick={start}
                    style={{ ...btn, opacity: canRun ? 1 : 0.6, fontWeight: 600, color: "var(--on-danfo)", border: "1px solid var(--danfo-edge)",
                      background: "linear-gradient(180deg, color-mix(in srgb, var(--danfo) 88%, white) 0%, var(--danfo) 100%)",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 1px 2px var(--elev-drop), 0 2px 6px var(--elev-drop-soft)" }}>
                    <Cube {...icon} />Run 3D here
                  </button>
                  <button type="button" disabled={!runId} aria-pressed={box.picking} onClick={() => setGpuBox({ picking: !box.picking })}
                    style={{ ...btn, ...raisedButton, fontWeight: 500, opacity: runId ? 1 : 0.6 }}>
                    <Crosshair {...icon} />{box.picking ? "Click the map" : "Pick the box on the map"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
