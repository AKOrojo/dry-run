// Drainage (design board 10): the Scenario tab's Drainage card, the Drains map layer and its legend, the dock's
// "Drain network running full" chart and the "Where the water went" panel. Data and the card store live in lib/drainage.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import * as Cesium from "cesium";
import { Info, ListBullets, Drop } from "@phosphor-icons/react";
import type { AOIManifest, RunManifest } from "../lib/api";
import { useLayers } from "../lib/layers";
import {
  designMmH, drainStats, fillAt, fillTone, FULL_PCT, getDrainFill, getDrains, returnPeriods, setDrainage, resetDrainage,
  SYSTEM_EXPLAIN, SYSTEM_LABEL, SYSTEM_SHORT, useDrainage,
} from "../lib/drainage";
import type { DrainCard, DrainFeature, DrainFill, DrainKind, DrainSystem, Outfall } from "../lib/drainage";
import { Anchored } from "./Anchored";
import type { Anchors } from "./Anchored";
import { Slider } from "./controls/Slider";
import { Switch as Toggle } from "./controls/Switch";
import { Band, Card, Field, FIG, NumberInput, raisedButton, Segmented, TextAction } from "./rev5";
import { fmtT } from "./ds";

const hint: CSSProperties = { margin: 0, color: "var(--ink-muted)", fontSize: 12, lineHeight: "16px" };
const MM_PER_IN = 25.4;
const SYSTEMS: { value: DrainSystem; label: string }[] = (["closed", "open", "mixed"] as const).map((v) => ({ value: v, label: SYSTEM_LABEL[v] }));
const OUTFALLS: { value: Outfall; label: string }[] = [{ value: "tide", label: "Tide-limited" }, { value: "free", label: "Free" }, { value: "blocked", label: "Blocked" }];
const TYPED = "mmh";

type LineKind = "open_drain" | "covered_drain" | "gutter_inferred" | "canal";
const LINE_KINDS: LineKind[] = ["canal", "open_drain", "covered_drain", "gutter_inferred"];
const LINE_STYLE: Record<LineKind, { width: number; dash?: boolean; label: string }> = {
  open_drain: { width: 5, label: "Open drain" },
  covered_drain: { width: 5, dash: true, label: "Covered section" },
  gutter_inferred: { width: 2.5, label: "Roadside gutter" },
  canal: { width: 6, label: "Canal" },
};
const isLine = (k: DrainKind): k is LineKind => (LINE_KINDS as string[]).includes(k);

/** Share of the mapped drain length that OpenStreetMap has (the rest of the gutters are inferred along roads), or null. */
function osmShare(fs: DrainFeature[] | null): number | null {
  if (!fs) return null;
  let osm = 0, all = 0;
  for (const f of fs) {
    if (!isLine(f.properties.kind)) continue;
    const len = partsOf(f).reduce((s, p) => s + pathM(p), 0);
    all += len;
    if (f.properties.source === "osm") osm += len;
  }
  return all > 0 && osm > 0 ? osm / all : null;
}

// ============================================================ the Scenario card
export function DrainageCard({ aoi, run }: { aoi?: AOIManifest; run?: RunManifest }) {
  const d = useDrainage();
  const [drains, setDrains] = useState<DrainFeature[] | null>(null);
  useEffect(() => {
    setDrains(null);
    if (!aoi?.drainage_default) return;
    let off = false;
    getDrains(aoi.aoi_id).then((fs) => { if (!off) setDrains(fs); });
    return () => { off = true; };
  }, [aoi?.aoi_id]);
  const share = useMemo(() => osmShare(drains), [drains]);
  const def = d.def, c = d.card;
  if (!aoi || !def || !c || d.aoiId !== aoi.aoi_id) return null;
  const rps = returnPeriods(def);
  const assumed = !def.sources?.length;
  const recv = def.receiving;
  const place = aoi.name.split(",")[0].trim();
  const mmh = c.returnPeriod != null ? designMmH(def, c.returnPeriod) ?? c.capacityMmH : c.capacityMmH;
  // Closed: a design rain rate for the sewers. Open or mixed: what the drains carry out when full, spread over the
  // whole area (Eng A), a different and usually much smaller quantity.
  const outlet = c.system !== "closed";
  const capText = outlet ? `${+mmh.toFixed(1)} mm/h, spread over the area${assumed ? " (assumed)" : ""}`
    : `${+mmh.toFixed(1)} mm/h of rain${rps.length ? ` (${+(mmh / MM_PER_IN).toFixed(1)} in/h)` : ""}${assumed ? " (assumed)" : ""}`;
  const outletExplain = `For open drains this is how much rain the drains can carry out to the ${recv} when they run full, spread over the whole area.`
    + (def.system === "open" ? ` ${place}'s mapped drains reach the ${recv} only through narrow roadside channels on very flat ground, so it is low; most of the storm is held in the drains and streets.` : "");
  const [lo, hi] = def.blockage_range_pct;
  const limits = (run?.status === "done" && run.scenario.aoi_id === aoi.aoi_id && run.drainage_limits?.length ? run.drainage_limits : def.limits) ?? [];
  const outfallHint = c.outfall === "tide" ? `Water leaves only while the drains stand above the ${recv} level.`
    : c.outfall === "free" ? `Water leaves as fast as the drains carry it, whatever the ${recv} level.`
    : "Nothing leaves the drains: they fill and spill back onto the road.";
  return (
    <Card title="Drainage" right={
      <span title={`${SYSTEM_LABEL[def.system as DrainSystem]} is the ${place} default`} style={{ marginLeft: "auto", minWidth: 0, display: "flex", alignItems: "center", gap: 6, color: "var(--ink-muted)", fontSize: 12, whiteSpace: "nowrap" }}>
        {d.touched ? <>{SYSTEM_SHORT[c.system]}<TextAction onClick={() => resetDrainage(aoi.aoi_id, def)}>Reset to default</TextAction></>
          : <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{SYSTEM_SHORT[c.system]} · {place} default</span>}
      </span>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 14px 14px" }}>
        <Field label="System" hint={SYSTEM_EXPLAIN[c.system]}>
          <Segmented<DrainSystem> options={SYSTEMS} active={c.system} onChange={(system) => setDrainage({ system })} />
        </Field>
        <Field label={outlet ? "Outlet capacity" : "Sewer capacity (design)"} hint={outlet ? undefined : capText}>
          {rps.length > 0 && (
            <Segmented<string> options={[...rps.map((rp) => ({ value: String(rp), label: `${rp} yr` })), { value: TYPED, label: "mm/h" }]}
              active={c.returnPeriod != null ? String(c.returnPeriod) : TYPED}
              onChange={(v) => setDrainage(v === TYPED ? { returnPeriod: null, capacityMmH: mmh } : { returnPeriod: +v, capacityMmH: designMmH(def, +v) ?? c.capacityMmH })} />
          )}
          {c.returnPeriod == null && (
            <NumberInput value={c.capacityMmH} unit="mm/h" min={0} max={200} step={outlet ? 0.1 : 1} label={outlet ? "Outlet capacity, mm/h" : "Sewer capacity, mm/h"} onChange={(capacityMmH) => setDrainage({ capacityMmH })} />
          )}
          {outlet && <><p style={hint}>{capText}</p><p style={hint}>{outletExplain}</p></>}
        </Field>
        <Slider label="Blocked by debris and silt" value={c.blockagePct} min={lo} max={hi} step={5} text={`${c.blockagePct} %`} lo={`${lo} %`} hi={`${hi} %`}
          onChange={(blockagePct) => setDrainage({ blockagePct })} />
        <Field label="Outfall" hint={outfallHint}>
          <Segmented<Outfall> options={OUTFALLS} active={c.outfall} onChange={(outfall) => setDrainage({ outfall })} />
        </Field>
        <ToggleRow on={c.flapGates} label="Flap gates on outfalls" note={c.flapGates ? "no backflow" : `open mouths: the ${recv} can back up`} onChange={(flapGates) => setDrainage({ flapGates })} />
        {c.system !== "closed" && (
          <ToggleRow on={c.roadsideGutters} label="Add roadside gutters" note={share != null ? `OSM maps ~${Math.max(1, Math.round(share * 100))} %` : undefined}
            onChange={(roadsideGutters) => setDrainage({ roadsideGutters })} />
        )}
        {limits.length > 0 && (
          <div style={{ display: "flex", gap: 8, padding: "10px 12px", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", background: "var(--ground)" }}>
            <Info size={14} weight="bold" color="var(--ink-muted)" style={{ flex: "none", marginTop: 1 }} />
            <span style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, lineHeight: "16px" }}>{limits.map((l) => <span key={l}>{l}</span>)}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

function ToggleRow({ on, label, note, onChange }: { on: boolean; label: string; note?: string; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ flex: "1 1 auto", minWidth: 0 }}><Toggle on={on} label={label} onChange={onChange} /></span>
      {note && <span style={{ flex: "0 1 auto", textAlign: "right", color: "var(--ink-muted)", fontSize: 12, lineHeight: "16px" }}>{note}</span>}
    </div>
  );
}

// ============================================================ geometry helpers
type LL = [number, number];
const partsOf = (f: DrainFeature): LL[][] => {
  const g = f.geometry;
  if (g.type === "LineString") return [g.coordinates];
  if (g.type === "MultiLineString") return g.coordinates;
  if (g.type === "Polygon") return [g.coordinates[0]];
  if (g.type === "MultiPolygon") return g.coordinates.map((p: LL[][]) => p[0]);
  return [];
};
const segM = (a: LL, b: LL) => {
  const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 110540);
};
const pathM = (p: LL[]) => p.slice(1).reduce((s, q, i) => s + segM(p[i], q), 0);
/** The point halfway along a line (where its chip goes). */
function midOf(p: LL[]): LL {
  const half = pathM(p) / 2;
  let run = 0;
  for (let i = 1; i < p.length; i++) {
    const s = segM(p[i - 1], p[i]);
    if (run + s >= half && s > 0) { const t = (half - run) / s; return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]; }
    run += s;
  }
  return p[0];
}
const centroidOf = (ring: LL[]): LL => {
  const n = Math.max(1, ring.length - 1);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
};
/** Douglas–Peucker in local metres: the zones come off the model grid as staircases. */
function simplify(p: LL[], tolM: number): LL[] {
  if (p.length < 4) return p;
  const k = 111320 * Math.cos((p[0][1] * Math.PI) / 180), m = 110540;
  const keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = p[a][0] * k, ay = p[a][1] * m, bx = p[b][0] * k, by = p[b][1] * m, dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let best = -1, far = tolM;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (p[i][0] * k - ax) - dx * (p[i][1] * m - ay)) / len;
      if (d > far) { far = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = p.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : p;
}
const ZONE_TOL_M = 15;
const inRing = (q: LL, ring: LL[]) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > q[1]) !== (yj > q[1]) && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Points every ~STEP m along a line, so a line lifted over the terrain follows it. */
const STEP_M = 30;
function densify(p: LL[]): LL[] {
  const out: LL[] = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const n = Math.min(50, Math.ceil(segM(p[i - 1], p[i]) / STEP_M));
    for (let k = 1; k <= n; k++) out.push([p[i - 1][0] + ((p[i][0] - p[i - 1][0]) * k) / n, p[i - 1][1] + ((p[i][1] - p[i - 1][1]) * k) / n]);
  }
  return out;
}

const llKey = (q: LL) => `${q[0].toFixed(6)},${q[1].toFixed(6)}`;

const cssColor = (name: string) => Cesium.Color.fromCssColorString(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
const toneColor = (pct: number | null | undefined) => { const t = fillTone(pct); return cssColor(t.token).withAlpha(t.alpha); };
/** Tone bucket of a fill (0 = no fill yet): lines only rebuild when a bucket changes. */
const bucketOf = (pct: number | null | undefined) => (pct == null ? 0 : pct < 40 ? 1 : pct < 80 ? 2 : pct < FULL_PCT ? 3 : 4);
const BUCKET_PCT = [null, 0, 40, 80, FULL_PCT];
/** No fill yet (before a run, or a line the run has no fill for): muted ink, gutters thinner still; full strength
 *  only once the fill colours apply. */
const mutedColor = (kind: LineKind) => cssColor("--ink").withAlpha(kind === "gutter_inferred" ? 0.35 : 0.5);
const mutedWidth = (kind: LineKind) => (kind === "gutter_inferred" ? 1.5 : LINE_STYLE[kind].width - 1);
/** Zone labels: the fullest few in view, plus the zone under the cursor. Outfall chips only close in. */
const ZONE_LABELS = 6, OUTFALL_CHIPS = 6;
/** Photoreal: lines float this far over the terrain (the 3D tiles hide a ground-clamped line), dimmer where buildings hide them. */
const PHOTOREAL_LIFT_M = 15;
/** Outfall chips only show when the camera is this low. */
// Terrain level for heights under drains: about 30 m posts, the model's own grid, and a handful of tiles. "Most detailed"
// went to level 15-16 over the US and asked for thousands of tiles for Queens' catch basins.
const TERRAIN_LEVEL = 12;
const INLET_MAX_M = 1800;
/** Inlets (thousands of catch basins) only at street scale: under this many metres per pixel at the view centre. */
const INLET_MAX_MPP = 0.8;
const CHIP_MAX = 5, CHIP_MIN_PCT = 80;

type Line = { id: string; kind: LineKind; name: string | null; parts: LL[][]; mid: LL };
type Zone = { id: string; name: string | null; parts: LL[][]; at: LL };
type Point = { id: string; at: LL; name: string | null; receiving: string | null; gated: boolean | null };

/** What the map shows follows the drainage in effect: the shown run's (as it ran), else the card's. Open systems have no
 *  sewer zones or inlets; gutters only when roadside gutters are on (never on closed systems). */
function shownKinds(aoi: AOIManifest | undefined, done: RunManifest | undefined, card: DrainCard | null) {
  const def = aoi?.drainage_default;
  const sent = done?.scenario.drainage;
  const system = ((done ? sent?.system : card?.system) ?? def?.system ?? "closed") as DrainSystem;
  const gutters = system !== "closed" && !!((done ? sent?.roadside_gutters : card?.roadsideGutters) ?? def?.roadside_gutters);
  return (k: DrainKind) => (k === "gutter_inferred" ? gutters : k === "sewer_zone" || k === "inlet" ? system !== "open" : true);
}

function useDrainLayer(aoi?: AOIManifest, run?: RunManifest, runsBase?: string) {
  const lay = useLayers();
  const card = useDrainage().card;
  const on = lay.drains.on && !!aoi?.drainage_default;
  const [fs, setFs] = useState<DrainFeature[] | null>(null);
  useEffect(() => {
    setFs(null);
    if (!on || !aoi) return;
    let off = false;
    getDrains(aoi.aoi_id).then((x) => { if (!off) setFs(x); });
    return () => { off = true; };
  }, [on, aoi?.aoi_id]);
  const done = run?.status === "done" && run.scenario.aoi_id === aoi?.aoi_id ? run : undefined;
  // undefined while loading; null on a legacy run (no fill): the layer is then hidden rather than shown empty.
  const [fill, setFill] = useState<DrainFill | null | undefined>(undefined);
  useEffect(() => {
    setFill(undefined);
    if (!on || !done || !runsBase) return;
    let off = false;
    getDrainFill(runsBase, done).then((x) => { if (!off) setFill(x); });
    return () => { off = true; };
  }, [on, done?.run_id, runsBase]);  // eslint-disable-line react-hooks/exhaustive-deps
  const legacy = !!done && fill === null;
  const keep = shownKinds(aoi, done, card);
  const key = ["gutter_inferred", "sewer_zone", "inlet"].map((k) => +keep(k as DrainKind)).join("");
  const shown = useMemo(() => fs?.filter((f) => keep(f.properties.kind)) ?? null, [fs, key]);  // eslint-disable-line react-hooks/exhaustive-deps
  return { on: on && !!fs && !legacy, fs: shown, fill: done ? fill ?? null : null };
}

// ============================================================ the map layer
export function DrainsMap({ viewer, scene, anchors, aoi, run, tS, basemap, runsBase, hidden }: {
  viewer?: Cesium.Viewer; scene?: Cesium.Scene; anchors: React.MutableRefObject<Anchors>; aoi?: AOIManifest; run?: RunManifest; tS: number;
  basemap: "aerial" | "photoreal"; runsBase: string; hidden?: boolean;
}) {
  const { on, fs, fill } = useDrainLayer(aoi, run, runsBase);
  const show = on && !hidden && !!viewer;
  const { lines, zones, outfalls, inlets } = useMemo(() => {
    const lines: Line[] = [], zones: Zone[] = [], outfalls: Point[] = [], inlets: LL[] = [];
    for (const f of fs ?? []) {
      const p = f.properties;
      if (isLine(p.kind)) { const parts = partsOf(f).filter((q) => q.length > 1); if (parts.length) lines.push({ id: p.id, kind: p.kind, name: p.name ?? null, parts, mid: midOf(parts.reduce((a, b) => (pathM(b) > pathM(a) ? b : a))) }); }
      else if (p.kind === "sewer_zone") { const parts = partsOf(f).filter((q) => q.length > 2).map((q) => simplify(q, ZONE_TOL_M)); if (parts.length) zones.push({ id: p.id, name: p.name ?? null, parts, at: centroidOf(parts[0]) }); }
      else if (p.kind === "outfall" && f.geometry.type === "Point") outfalls.push({ id: p.id, at: f.geometry.coordinates, name: p.name ?? null, receiving: p.receiving ?? null, gated: p.gated ?? null });
      else if (p.kind === "inlet" && f.geometry.type === "Point") inlets.push(f.geometry.coordinates);
    }
    return { lines, zones, outfalls, inlets };
  }, [fs]);
  const fi = useMemo(() => {
    if (!fill) return -1;
    let best = 0;
    fill.t_s.forEach((t, i) => { if (Math.abs(t - tS) < Math.abs(fill.t_s[best] - tS)) best = i; });
    return best;
  }, [fill, tS]);
  const pctOf = useMemo(() => (fill && fi >= 0 ? fillAt(fill, fill.t_s[fi]) : null), [fill, fi]);
  const toneKey = useMemo(() => [...lines, ...zones].map((x) => bucketOf(pctOf?.get(x.id))).join(""), [lines, zones, pctOf]);

  // Terrain heights under the points (inlets, outfalls) and, on Photoreal, every line vertex, sampled once per network. globe.getHeight only knows the tiles
  // loaded for the current view, and a line built before they load would sit under the 3D tiles.
  const photoreal = basemap === "photoreal";
  const [heights, setHeights] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    setHeights(null);
    if (!show || !viewer || viewer.isDestroyed() || (!lines.length && !zones.length && !inlets.length && !outfalls.length)) return;
    let off = false;
    const keys = new Map<string, Cesium.Cartographic>();
    const put = (q: LL) => keys.set(llKey(q), Cesium.Cartographic.fromDegrees(q[0], q[1]));
    if (photoreal) [...lines, ...zones].forEach((x) => x.parts.forEach((p) => densify(p).forEach(put)));
    inlets.forEach(put);
    outfalls.forEach((o) => put(o.at));
    const cartos = [...keys.values()];
    Cesium.sampleTerrain(viewer.terrainProvider, TERRAIN_LEVEL, cartos)
      .then(() => { if (!off) setHeights(new Map([...keys.keys()].map((k, i) => [k, cartos[i].height ?? 0]))); })
      .catch(() => { if (!off) setHeights(new Map()); });
    return () => { off = true; };
  }, [show, photoreal, viewer, lines, zones, inlets, outfalls]);

  // Lines (with a ground-coloured halo) and sewer-zone fills, rebuilt when a tone bucket changes.
  const prev = useRef<Cesium.PrimitiveCollection>();
  useEffect(() => {
    const drop = () => { if (viewer && !viewer.isDestroyed() && prev.current && !prev.current.isDestroyed()) viewer.scene.primitives.remove(prev.current); prev.current = undefined; };
    if (!show || !viewer || viewer.isDestroyed() || (!lines.length && !zones.length)) { drop(); if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender(); return; }
    if (photoreal && !heights) return;
    let live = true;
    const ready = photoreal ? Promise.resolve() : Promise.all([Cesium.GroundPolylinePrimitive.initializeTerrainHeights(), Cesium.GroundPrimitive.initializeTerrainHeights()]);
    ready.then(() => {
      if (!live || viewer.isDestroyed()) return;
      const globe = viewer.scene.globe;
      const lift = (p: LL[]) => densify(p).map((q) => Cesium.Cartesian3.fromDegrees(q[0], q[1],
        (heights?.get(llKey(q)) ?? globe.getHeight(Cesium.Cartographic.fromDegrees(q[0], q[1])) ?? 0) + PHOTOREAL_LIFT_M));
      const col = new Cesium.PrimitiveCollection();
      const ground = cssColor("--ground").withAlpha(0.75);
      const material = (c: Cesium.Color, dash?: boolean) => dash ? Cesium.Material.fromType("PolylineDash", { color: c, gapColor: Cesium.Color.TRANSPARENT, dashLength: 14 }) : Cesium.Material.fromType("Color", { color: c });
      const add = (parts: LL[][], width: number, c: Cesium.Color, dash?: boolean) => {
        if (!parts.length) return;
        if (photoreal) {
          const insts = parts.map((p) => new Cesium.GeometryInstance({ geometry: new Cesium.PolylineGeometry({ positions: lift(p), width, arcType: Cesium.ArcType.NONE, vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT }) }));
          col.add(new Cesium.Primitive({ geometryInstances: insts, asynchronous: false, appearance: new Cesium.PolylineMaterialAppearance({ material: material(c, dash) }),
            depthFailAppearance: new Cesium.PolylineMaterialAppearance({ material: material(c.withAlpha(c.alpha * 0.45), dash) }) }));
        } else {
          const insts = parts.map((p) => new Cesium.GeometryInstance({ geometry: new Cesium.GroundPolylineGeometry({ positions: Cesium.Cartesian3.fromDegreesArray(p.flat()), width }) }));
          col.add(new Cesium.GroundPolylinePrimitive({ geometryInstances: insts, asynchronous: false, appearance: new Cesium.PolylineMaterialAppearance({ material: material(c, dash) }) }));
        }
      };
      // Zones: a translucent fill in the tone of their storage (it carries the meaning) and a hairline outline.
      const zoneInsts = zones.flatMap((z) => z.parts.map((ring) => new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({ polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(ring.flat())) }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(toneColor(pctOf?.get(z.id) ?? null).withAlpha(0.2)) } })));
      if (zoneInsts.length) col.add(new Cesium.GroundPrimitive({ geometryInstances: zoneInsts, asynchronous: false, classificationType: photoreal ? Cesium.ClassificationType.BOTH : Cesium.ClassificationType.TERRAIN,
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }) }));
      const byBucket = (xs: { id: string }[]) => { const m = new Map<number, typeof xs>(); xs.forEach((x) => { const b = bucketOf(pctOf?.get(x.id)); m.set(b, [...(m.get(b) ?? []), x]); }); return m; };
      byBucket(zones).forEach((zs, b) => add((zs as Zone[]).flatMap((z) => z.parts), 1, b ? toneColor(BUCKET_PCT[b]).withAlpha(0.35) : cssColor("--ink").withAlpha(0.2)));
      // Unfilled lines muted; filled ones over a halo, by tone (thin gutters first, canals on top).
      for (const kind of [...LINE_KINDS].reverse()) {
        const st = LINE_STYLE[kind], groups = byBucket(lines.filter((l) => l.kind === kind));
        add(((groups.get(0) ?? []) as Line[]).flatMap((l) => l.parts), mutedWidth(kind), mutedColor(kind), st.dash);
        const filled = [...groups].filter(([b]) => b > 0);
        add(filled.flatMap(([, ls]) => (ls as Line[]).flatMap((l) => l.parts)), st.width + 3, ground);
        filled.forEach(([b, ls]) => add((ls as Line[]).flatMap((l) => l.parts), st.width, toneColor(BUCKET_PCT[b]), st.dash));
      }
      drop();
      viewer.scene.primitives.add(col);
      prev.current = col;
      viewer.scene.requestRender();
    }).catch(() => { /* terrain heights unavailable: no drains drawn */ });
    return () => { live = false; };
  }, [show, viewer, lines, zones, toneKey, basemap, heights]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (viewer && !viewer.isDestroyed() && prev.current && !prev.current.isDestroyed()) viewer.scene.primitives.remove(prev.current); }, [viewer]);

  // Inlets: small dots, only at street scale (the points outside the view are culled by Cesium).
  useEffect(() => {
    if (!show || !viewer || viewer.isDestroyed() || !inlets.length || !heights) return;
    const globe = viewer.scene.globe, lift = photoreal ? PHOTOREAL_LIFT_M : 1;
    const pts = new Cesium.PointPrimitiveCollection();
    const ink = cssColor("--ink").withAlpha(0.7);
    inlets.forEach(([lon, lat]) => pts.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat, (heights?.get(llKey([lon, lat])) ?? globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat)) ?? 0) + lift), pixelSize: 4, color: ink, outlineWidth: 0 }));
    pts.show = false;
    viewer.scene.primitives.add(pts);
    const s = viewer.scene;
    let last = 0;
    const near = () => {
      const now = performance.now();
      if (s.isDestroyed() || now - last < 200) return;
      last = now;
      const w = s.canvas.clientWidth, h = s.canvas.clientHeight;
      const hit = w && h ? s.camera.pickEllipsoid(new Cesium.Cartesian2(w / 2, h / 2), s.globe.ellipsoid) : undefined;
      const mpp = hit ? s.camera.getPixelSize(new Cesium.BoundingSphere(hit, 1), w, h) : Infinity;
      const show = mpp < INLET_MAX_MPP;
      if (show !== pts.show) { pts.show = show; s.requestRender(); }
    };
    near();
    s.postRender.addEventListener(near);
    s.requestRender();
    return () => { if (!s.isDestroyed()) { s.postRender.removeEventListener(near); s.primitives.remove(pts); } };
  }, [show, viewer, inlets, photoreal, heights]);

  // Outfall marks as billboards (hundreds of them; DOM marks would be re-placed every frame).
  useEffect(() => {
    if (!show || !viewer || viewer.isDestroyed() || !outfalls.length || !heights) return;
    const s = viewer.scene, dpr = Math.min(window.devicePixelRatio || 1, 2), px = 16;
    const cv = document.createElement("canvas"); cv.width = cv.height = px * dpr;
    const g = cv.getContext("2d")!; g.scale(dpr, dpr);
    const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    g.beginPath(); g.arc(8, 8, 6.5, 0, 2 * Math.PI); g.fillStyle = css("--ground"); g.fill(); g.lineWidth = 1.5; g.strokeStyle = css("--ink"); g.stroke();
    g.beginPath(); g.moveTo(4.5, 8); g.lineTo(11.5, 8); g.lineWidth = 1.8; g.lineCap = "round"; g.stroke();
    const bb = new Cesium.BillboardCollection({ scene: s });
    const lift = photoreal ? PHOTOREAL_LIFT_M : 2;
    outfalls.forEach((o) => bb.add({ image: cv, width: px, height: px, position: Cesium.Cartesian3.fromDegrees(o.at[0], o.at[1], (heights.get(llKey(o.at)) ?? 0) + lift) }));
    s.primitives.add(bb);
    s.requestRender();
    return () => { if (!s.isDestroyed()) s.primitives.remove(bb); };
  }, [show, viewer, outfalls, photoreal, heights]);

  // The view (for labels and chips) and the zone under the cursor.
  const [cam, setCam] = useState<{ rect: [number, number, number, number] | null; h: number }>({ rect: null, h: Infinity });
  const [hoverZone, setHoverZone] = useState<string | null>(null);
  useEffect(() => {
    if (!show || !viewer || viewer.isDestroyed()) return;
    const s = viewer.scene, c = viewer.camera, canvas = viewer.canvas;
    const update = () => {
      if (s.isDestroyed()) return;
      const r = c.computeViewRectangle();
      setCam({ rect: r ? [r.west, r.south, r.east, r.north].map(Cesium.Math.toDegrees) as [number, number, number, number] : null, h: c.positionCartographic.height });
    };
    update();
    c.moveEnd.addEventListener(update);
    let last = 0;
    const move = (e: MouseEvent) => {
      const now = performance.now();
      if (s.isDestroyed() || now - last < 150 || !zones.length) return;
      last = now;
      const r = canvas.getBoundingClientRect();
      const hit = c.pickEllipsoid(new Cesium.Cartesian2(e.clientX - r.left, e.clientY - r.top), s.globe.ellipsoid);
      if (!hit) { setHoverZone(null); return; }
      const g = Cesium.Cartographic.fromCartesian(hit), q: LL = [Cesium.Math.toDegrees(g.longitude), Cesium.Math.toDegrees(g.latitude)];
      setHoverZone(zones.find((z) => z.parts.some((ring) => inRing(q, ring)))?.id ?? null);
    };
    const leave = () => setHoverZone(null);
    canvas.addEventListener("mousemove", move);
    canvas.addEventListener("mouseleave", leave);
    // The viewer may already be destroyed (the area changed): its getters throw then, so use what was captured above.
    return () => { c.moveEnd.removeEventListener(update); canvas.removeEventListener("mousemove", move); canvas.removeEventListener("mouseleave", leave); };
  }, [show, viewer, zones]);
  const inView = (q: LL) => !cam.rect || (q[0] >= cam.rect[0] && q[0] <= cam.rect[2] && q[1] >= cam.rect[1] && q[1] <= cam.rect[3]);
  const zoneLabels = useMemo(() => {
    const named = zones.filter((z) => z.name);
    const top = pctOf ? named.filter((z) => inView(z.at)).sort((a, b) => (pctOf.get(b.id) ?? 0) - (pctOf.get(a.id) ?? 0)).slice(0, ZONE_LABELS) : [];
    const hov = named.find((z) => z.id === hoverZone);
    return hov && !top.includes(hov) ? [...top, hov] : top;
  }, [zones, pctOf, cam, hoverZone]);  // eslint-disable-line react-hooks/exhaustive-deps
  const outfallChips = useMemo(() => (cam.h < INLET_MAX_M ? outfalls.filter((o) => inView(o.at)).slice(0, OUTFALL_CHIPS) : []), [outfalls, cam]);  // eslint-disable-line react-hooks/exhaustive-deps

  const chips = useMemo(() => !pctOf ? [] : lines.map((l) => ({ l, pct: pctOf.get(l.id) ?? 0 })).filter((x) => x.pct >= CHIP_MIN_PCT).sort((a, b) => b.pct - a.pct).slice(0, CHIP_MAX), [lines, pctOf]);
  if (!show) return null;
  const level = run?.scenario.interventions?.find((i) => i.type === "tide") as { boundary_level_m: number } | undefined;
  const recvDefault = aoi?.drainage_default?.receiving ?? null;
  const gatesOn = (o: Point) => o.gated ?? aoi?.drainage_default?.flap_gates ?? false;
  return (
    <>
      {zoneLabels.map((z) => {
        const p = pctOf?.get(z.id);
        return (
          <Anchored key={z.id} anchors={anchors} scene={scene} lon={z.at[0]} lat={z.at[1]}>
            <span data-declutter={1} style={{ ...zoneLabel, transform: "translate(-50%, -50%)" }}>{z.name}{p != null ? ` · ${Math.round(p)} % full` : ""}</span>
          </Anchored>
        );
      })}
      {outfallChips.map((o) => (
        <Anchored key={o.id} anchors={anchors} scene={scene} lon={o.at[0]} lat={o.at[1]}>
          <span data-declutter={2} data-flip-x="0" title={o.name ?? undefined} style={{ ...chip, position: "absolute", left: 12, right: "auto", top: -8 }}>
            <span style={{ display: "block", fontWeight: 600 }}>Outfall to {o.receiving ?? recvDefault ?? "the receiving water"}</span>
            <span style={{ display: "block", color: "var(--ink-muted)" }}>{gatesOn(o) ? "gated" : "open mouth"}{level ? ` · ${level.boundary_level_m >= 0 ? "+" : "−"}${Math.abs(level.boundary_level_m).toFixed(1)} m` : ""}</span>
          </span>
        </Anchored>
      ))}
      {chips.map(({ l, pct }) => (
        <Anchored key={l.id} anchors={anchors} scene={scene} lon={l.mid[0]} lat={l.mid[1]} dy={-6}>
          <span data-declutter={3} style={{ ...chip, position: "absolute", left: 0, top: 0, transform: "translate(-50%, -100%)" }}>
            <span style={{ display: "block", fontWeight: 600 }}>{l.name ?? LINE_STYLE[l.kind].label}</span>
            <span style={{ display: "block", color: pct >= FULL_PCT ? "var(--hazard)" : "var(--ink-muted)" }}>{Math.round(pct)} % full{pct >= FULL_PCT ? " · overflowing" : ""}</span>
          </span>
        </Anchored>
      ))}
    </>
  );
}

const chip: CSSProperties = {
  display: "block", padding: "3px 8px 4px", background: "color-mix(in srgb, var(--ground) 84%, transparent)", backdropFilter: "blur(6px)", color: "var(--ink)",
  border: "1px solid color-mix(in srgb, var(--ink) 10%, transparent)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", whiteSpace: "nowrap",
  fontSize: 12, lineHeight: "16px", ...FIG,
};
const zoneLabel: CSSProperties = { display: "block", position: "absolute", left: 0, top: 0, color: "var(--ink)", fontSize: 12, lineHeight: "16px", fontWeight: 600, whiteSpace: "nowrap",
  textShadow: "0 0 3px var(--ground), 0 0 6px var(--ground)", ...FIG };

/** The outfall mark: a disc with a bar across its mouth. */
function OutfallMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style={{ display: "block" }}>
      <circle cx="8" cy="8" r="6.5" fill="var(--ground)" stroke="var(--ink)" strokeWidth="1.5" />
      <path d="M4.5 8h7" stroke="var(--ink)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

// ============================================================ legend (bottom-left stack)
export function DrainsLegend({ aoi, run, runsBase }: { aoi?: AOIManifest; run?: RunManifest; runsBase: string }) {
  const { on, fs, fill } = useDrainLayer(aoi, run, runsBase);
  if (!on || !fs) return null;
  const kinds = new Set(fs.map((f) => f.properties.kind));
  const swatch = (k: LineKind) => (
    <svg width="28" height="10" viewBox="0 0 28 10" aria-hidden="true">
      <line x1="1" y1="5" x2="27" y2="5" stroke="var(--ground)" strokeWidth={LINE_STYLE[k].width / 1.5 + 2} />
      <line x1="1" y1="5" x2="27" y2="5" stroke="var(--ink)" strokeWidth={LINE_STYLE[k].width / 1.5} strokeDasharray={LINE_STYLE[k].dash ? "5 3" : undefined} />
    </svg>
  );
  const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 12, lineHeight: "16px", whiteSpace: "nowrap" };
  return (
    <div className="ft-legend" style={{ pointerEvents: "none", boxShadow: "var(--shadow-float)", gap: 6 }}>
      <span style={{ fontSize: 13, lineHeight: "18px", fontWeight: 600 }}>Drains</span>
      {LINE_KINDS.filter((k) => kinds.has(k)).map((k) => <span key={k} style={row}>{swatch(k)}{LINE_STYLE[k].label}</span>)}
      {kinds.has("sewer_zone") && <span style={row}><span style={{ width: 28, display: "flex", justifyContent: "center" }}><span style={{ width: 14, height: 10, border: "1.5px solid var(--ink)", background: "color-mix(in srgb, var(--ink) 20%, transparent)", borderRadius: 2 }} /></span>Sewer zone</span>}
      {kinds.has("inlet") && <span style={row}><span style={{ width: 28, display: "flex", justifyContent: "center" }}><span style={{ width: 4, height: 4, borderRadius: "50%", background: "color-mix(in srgb, var(--ink) 70%, transparent)" }} /></span>Inlet (street scale)</span>}
      {kinds.has("outfall") && <span style={row}><span style={{ width: 28, display: "flex", justifyContent: "center" }}><OutfallMark size={14} /></span>Outfall</span>}
      {fill && (
        <>
          <span style={{ display: "flex", width: 168, height: 8, marginTop: 4, borderRadius: "var(--radius-pill)", overflow: "hidden", border: "var(--stroke-hairline) solid var(--hairline)" }}>
            {[[0, 40], [40, 80], [80, FULL_PCT], [FULL_PCT, 100]].map(([a, b]) => { const t = fillTone(a); return <span key={a} style={{ width: `${b - a}%`, background: `color-mix(in srgb, var(${t.token}) ${t.alpha * 100}%, transparent)` }} />; })}
          </span>
          <span style={{ display: "flex", justifyContent: "space-between", width: 168, fontSize: 11, color: "var(--ink-muted)", ...FIG }}><span>empty</span><span>80 %</span><span>full</span></span>
        </>
      )}
    </div>
  );
}

// ============================================================ dock
/** Cubic metres to two or three significant figures: "412,000 m³". */
const m3 = (v: number) => { const r = v >= 10000 ? 1000 : v >= 100 ? 10 : 1; return `${(Math.round(v / r) * r).toLocaleString("en-US")} m³`; };

/** Side-panel switch: an icon button in the band of whichever panel is showing. */
export function SideSwitch({ to, onClick }: { to: "events" | "water"; onClick: () => void }) {
  const label = to === "events" ? "Key events" : "Where the water went";
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      style={{ marginLeft: to === "events" ? "auto" : 0, width: 26, height: 26, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, ...raisedButton, borderRadius: "var(--radius-md)", cursor: "pointer" }}>
      {to === "events" ? <ListBullets size={14} weight="bold" /> : <Drop size={14} weight="bold" />}
    </button>
  );
}

/** "Where the water went": what the drains took, gave back, let out and still hold. */
export function WaterWent({ run, onEvents }: { run: RunManifest; onEvents: () => void }) {
  const s = drainStats(run);
  const recv = useDrainage().def?.receiving ?? "receiving water";
  if (!s) return null;
  const outfall = (run.scenario.drainage?.outfall as Outfall | undefined) ?? "tide";
  // The first row is the sum of the next two (read top-down); the gross spill comes after a hairline.
  const rows: { label: string; v: number | null; sub: string; on?: boolean; part?: boolean; rule?: boolean }[] = [
    { label: "Taken off the streets", v: s.drained, sub: s.rainM3 && s.drained != null ? `${Math.round((100 * s.drained) / s.rainM3)} % of the rain` : "" },
    { label: `Out to the ${recv}`, v: s.outfall, part: true, sub: outfall === "tide" ? `while the ${recv} was lower` : outfall === "free" ? "free outfall" : "outfalls blocked" },
    { label: "Gained in the drains", v: s.storageEnd, part: true, sub: "by the end, over what they held at the start" },
    { label: "Back onto the road", v: s.surcharge, rule: true, sub: "counts each spill; water can overflow more than once", on: (s.surcharge ?? 0) > 0 },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid var(--hairline)", minHeight: 0, background: "var(--surface)" }}>
      <Band title="Where the water went" right={<SideSwitch to="events" onClick={onEvents} />} />
      <ol style={{ margin: 0, padding: 0, listStyle: "none", minHeight: 0, overflowY: "auto" }}>
        {rows.map((r) => (
          <li key={r.label} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", columnGap: 10, rowGap: 2, padding: "8px 12px 8px 14px",
            ...(r.rule ? { borderTop: "1px solid var(--hairline)" } : {}),
            ...(r.on ? { background: "var(--surface-raised)", boxShadow: "inset 3px 0 0 var(--danfo), inset 0 1px 0 var(--elev-hi)" } : {}) }}>
            <span style={{ fontWeight: r.on ? 600 : r.part ? 400 : 500 }}>{r.label}</span>
            <span style={{ fontSize: 12, ...FIG }}>{r.v != null ? m3(r.v) : "–"}</span>
            {r.sub && <span style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--ink-muted)" }}>{r.sub}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
