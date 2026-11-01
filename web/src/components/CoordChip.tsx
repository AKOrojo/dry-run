// Coordinate chip, bottom-left of the map: the cursor's position (the map centre when the cursor is off the map),
// the model ground height there (the AOI DEM above sea level, from the API; "–" outside the model area), DMS or decimal, a "Go to lat, lon" box that flies there and marks the spot, and copy.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import * as Cesium from "cesium";
import { Check, Copy, Crosshair } from "@phosphor-icons/react";
import { Anchored } from "./Anchored";
import type { Anchors } from "./Anchored";
import { FIG, mono } from "./rev5";
import { getPointInfo } from "../lib/api";
import { TextField } from "./controls/TextField";
import { Tooltip } from "./controls/Tooltip";

type Fmt = "DMS" | "Decimal";
const FMT_KEY = "dr_coord_fmt";
const readFmt = (): Fmt => { try { return localStorage.getItem(FMT_KEY) === "Decimal" ? "Decimal" : "DMS"; } catch { return "DMS"; } };

function dms(v: number, pos: string, neg: string): string {
  const a = Math.abs(v);
  let d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60);
  if (s === 60) { s = 0; m += 1; }
  if (m === 60) { m = 0; d += 1; }
  return `${d}°${String(m).padStart(2, "0")}′${String(s).padStart(2, "0")}″${v < 0 ? neg : pos}`;
}
export const formatLL = (lat: number, lon: number, fmt: Fmt) =>
  fmt === "DMS" ? `${dms(lat, "N", "S")} ${dms(lon, "E", "W")}` : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

/** One coordinate: "6.465", "-3.5", "6°27′54″N", "6 27 54 N". Returns degrees and the hemisphere letter if one was given. */
function parsePart(part: string): { deg: number; hemi: string | null } | null {
  const hemi = part.match(/[NSEW]/i)?.[0].toUpperCase() ?? null;
  const rest = part.replace(/[NSEW]/gi, " ");
  if (/[^\d\s.+\-°′″'"º]/.test(rest)) return null;
  const nums = rest.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (!nums.length || nums.length > 3 || (nums.length > 1 && !Number.isInteger(nums[0]))) return null;
  const [d, m = 0, s = 0] = nums;
  if (m >= 60 || s >= 60) return null;
  let deg = d + m / 60 + s / 3600;
  if (/^\s*[-−]/.test(rest) || hemi === "S" || hemi === "W") deg = -deg;
  return { deg, hemi };
}
/** "6.465, 3.545", "6°27′54″N 3°33′18″E", "6 27 54 N, 3 33 18 E", "N 6.46 E 3.55". Errors say what is wrong. */
export function parseLatLon(text: string): { lat: number; lon: number } | { error: string } {
  const t = text.trim();
  if (!t) return { error: "Type a latitude and longitude, like 6.465, 3.545" };
  let parts: string[];
  if (t.includes(",")) parts = t.split(",").map((s) => s.trim());
  else {
    // DMS without a comma: split after the first hemisphere letter, or before a second one.
    const m = t.match(/^(.*?[NSEW])\s*(.+)$/i) ?? t.match(/^([NSEW]\s*[^NSEW]+?)\s+([NSEW].*)$/i);
    parts = m ? [m[1], m[2]] : t.split(/\s+/).length === 2 ? t.split(/\s+/) : [];
  }
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { error: "Use two numbers: latitude, longitude" };
  const a = parsePart(parts[0]), b = parsePart(parts[1]);
  if (!a || !b) return { error: "Could not read that. Try 6.465, 3.545 or 6°27′54″N 3°33′18″E" };
  const lonFirst = a.hemi === "E" || a.hemi === "W" || b.hemi === "N" || b.hemi === "S";
  const lat = lonFirst ? b.deg : a.deg, lon = lonFirst ? a.deg : b.deg;
  if (Math.abs(lat) > 90) return { error: "Latitude must be between −90 and 90" };
  if (Math.abs(lon) > 180) return { error: "Longitude must be between −180 and 180" };
  return { lat, lon };
}

const tray = { background: "var(--ground)", borderRadius: "var(--radius-md)", boxShadow: "var(--inset-shadow)" } as const;

export function CoordChip({ viewer, scene, anchors, aoiId, bounds, bottom = 26, left = 16, maxWidth }: { viewer?: Cesium.Viewer; scene?: Cesium.Scene; anchors: React.MutableRefObject<Anchors>; aoiId?: string; bounds?: number[];
  /** Where it sits (above the map's credit line) and how wide it may grow before the map's other bottom controls:
   *  past that the Go-to box shrinks, then the row wraps. */
  bottom?: number; left?: number; maxWidth?: string }) {
  const [fmt, setFmt] = useState<Fmt>(readFmt);
  const [at, setAt] = useState<{ lat: number; lon: number } | null>(null);
  const [ground, setGround] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [mark, setMark] = useState<{ lat: number; lon: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const cursor = useRef(false);
  const markTimer = useRef<number>();

  const pickFmt = (f: Fmt) => { setFmt(f); try { localStorage.setItem(FMT_KEY, f); } catch { /* storage blocked */ } };

  // A new area: the last position belongs to the old one (asking the new area's DEM for it is a 400).
  useEffect(() => { setAt(null); setMark(null); }, [aoiId]);
  // The 3D map's heights are ellipsoidal (tens of metres off sea level), so ground comes from the model's DEM once the pointer rests.
  useEffect(() => {
    // Outside the model grid there is no DEM (the API answers 400), so ground is "–" without asking.
    const out = bounds && (at ? at.lon < bounds[0] || at.lat < bounds[1] || at.lon > bounds[2] || at.lat > bounds[3] : false);
    if (!at || !aoiId || out) { setGround(null); return; }
    let live = true;
    const id = window.setTimeout(() => {
      getPointInfo(aoiId, at.lon, at.lat).then((p) => { if (live) setGround(p ? p.ground_m : null); }).catch(() => { if (live) setGround(null); });
    }, 250);
    return () => { live = false; window.clearTimeout(id); };
  }, [at?.lat, at?.lon, aoiId, bounds]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const canvas = viewer.canvas, s = viewer.scene;
    const sample = (x: number, y: number) => {
      if (s.isDestroyed()) return;
      const p = s.globe.pick(viewer.camera.getPickRay(new Cesium.Cartesian2(x, y)) as Cesium.Ray, s);
      if (!p) return;
      const c = Cesium.Cartographic.fromCartesian(p);
      setAt({ lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) });
    };
    let raf = 0, last = { x: 0, y: 0 };
    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      last = { x: e.clientX - r.left, y: e.clientY - r.top };
      cursor.current = true;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; sample(last.x, last.y); });
    };
    const onLeave = () => { cursor.current = false; };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    // Off the map: the centre of the view, refreshed a few times a second as the camera moves.
    let lastC = 0;
    const off = s.postRender.addEventListener(() => {
      const now = performance.now();
      if (cursor.current || now - lastC < 350) return;
      lastC = now;
      sample(canvas.clientWidth / 2, canvas.clientHeight / 2);
    });
    return () => { canvas.removeEventListener("mousemove", onMove); canvas.removeEventListener("mouseleave", onLeave); off(); if (raf) cancelAnimationFrame(raf); };
  }, [viewer]);
  useEffect(() => () => window.clearTimeout(markTimer.current), []);

  const goTo = () => {
    const p = parseLatLon(text);
    if ("error" in p) { setErr(p.error); return; }
    if (!viewer || viewer.isDestroyed()) return;
    setErr(null);
    setMark({ lat: p.lat, lon: p.lon });
    window.clearTimeout(markTimer.current);
    markTimer.current = window.setTimeout(() => setMark(null), 12000);
    const cam = viewer.camera;
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0), 1),
      { duration: 1.6, offset: new Cesium.HeadingPitchRange(cam.heading, Math.min(cam.pitch, -0.45), 2200) });
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); goTo(); }
    else if (e.key === "Escape") { setErr(null); setMark(null); (e.target as HTMLInputElement).blur(); }
  };
  const copy = async () => {
    if (!at) return;
    const s = formatLL(at.lat, at.lon, fmt);
    try { await navigator.clipboard.writeText(s); setCopied(true); window.setTimeout(() => setCopied(false), 1400); } catch { /* clipboard blocked */ }
  };
  const iconBtn = { display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, background: "transparent", border: 0, borderRadius: 3, color: "var(--ink-muted)", cursor: "pointer" } as const;
  const seg = (on: boolean) => ({ height: 20, padding: "0 7px", border: 0, borderRadius: 3, fontFamily: "inherit", fontSize: 11, cursor: "pointer",
    ...(on ? { background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", fontWeight: 600 } : { background: "transparent", color: "var(--ink-muted)" }) }) as const;

  return (
    <>
      {mark && scene && (
        <Anchored anchors={anchors} scene={scene} lon={mark.lon} lat={mark.lat}>
          <span data-testid="coord-marker" style={{ position: "absolute", left: -11, top: -11, width: 22, height: 22, display: "block", border: "2px solid var(--danfo)", borderRadius: "50%",
            background: "color-mix(in srgb, var(--danfo) 22%, transparent)", boxShadow: "0 0 0 2px var(--ground)" }} />
        </Anchored>
      )}
      <div data-tour="coords" data-declutter-block style={{ position: "absolute", left, bottom, maxWidth, display: "flex", flexDirection: "column", gap: 4, pointerEvents: "auto" }}>
        {err && <span role="alert" style={{ alignSelf: "flex-start", padding: "3px 9px", fontSize: 11, color: "var(--hazard)", background: "color-mix(in srgb, var(--ground) 90%, transparent)",
          border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)" }}>{err}</span>}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, rowGap: 6, padding: "6px 8px 6px 10px", background: "color-mix(in srgb, var(--ground) 86%, transparent)", backdropFilter: "blur(6px)",
          border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", fontSize: 12, whiteSpace: "nowrap" }}>
          <Crosshair size={14} color="var(--ink-muted)" style={{ flex: "none" }} aria-hidden="true" />
          <span data-testid="coord-text" style={{ fontFamily: mono, minWidth: fmt === "DMS" ? 168 : 128, ...FIG }}>{at ? formatLL(at.lat, at.lon, fmt) : "–"}</span>
          <span style={{ color: "var(--ink-muted)", ...FIG }}>ground {ground != null ? `${ground.toFixed(1)} m` : "–"}</span>
          <span role="group" aria-label="Coordinate format" style={{ display: "flex", padding: 2, gap: 2, ...tray }}>
            <button type="button" aria-pressed={fmt === "DMS"} onClick={() => pickFmt("DMS")} style={seg(fmt === "DMS")}>DMS</button>
            <button type="button" aria-pressed={fmt === "Decimal"} onClick={() => pickFmt("Decimal")} style={seg(fmt === "Decimal")}>Decimal</button>
          </span>
          <TextField value={text} onChange={(e) => { setText(e.target.value); setErr(null); }} onKeyDown={onKey} placeholder="Go to lat, lon…" aria-label="Go to latitude, longitude" aria-invalid={!!err}
            spellCheck={false} autoComplete="off"
            mono style={{ width: 150, flex: "0 1 150px", minWidth: 60, height: 24, padding: "0 8px", fontSize: 11 }} />
          <Tooltip text={copied ? "Copied" : "Copy coordinates"}><button type="button" aria-label={copied ? "Copied" : "Copy coordinates"} onClick={copy} style={iconBtn}>
            {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
          </button></Tooltip>
        </div>
      </div>
    </>
  );
}
