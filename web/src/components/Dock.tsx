// Dock (rev 5 dock()): timeline, three charts, key events. Everything reads the one clock.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { CaretDown, Camera, ChartBar, Copy, DotsThreeVertical, NotePencil, Plus, X } from "@phosphor-icons/react";
import type { RunEvents, RunManifest } from "../lib/api";
import { setFocus } from "../lib/focus";
import { useExtras } from "../lib/extras";
import { clock, useClock } from "../lib/clock";
import { addNote, removeNote, useNotes } from "../lib/notes";
import { fmtT } from "./ds";
import { depthByPlace, hyetograph, isCell, useRain } from "../lib/rain";
import { RainNow } from "./RainNow";
import { useWeatherSource } from "../lib/weather";
import { useLayers } from "../lib/layers";
import { lazyNamed } from "../lib/lazy";
import { chartCsv, chartFilename, chartTable } from "../lib/chartdata";
import { chartPng } from "../lib/chartImage";
import { labelWidth, thinTicks } from "../lib/ticks";
const LoadsPanel = lazyNamed(() => import("./FlowHazard"), "LoadsPanel");
const ProfileDock = lazyNamed(() => import("./FlowHazard"), "ProfileDock");
import { drainNote, drainSeries } from "../lib/drainage";
const SideSwitch = lazyNamed(() => import("./Drainage"), "SideSwitch");
const WaterWent = lazyNamed(() => import("./Drainage"), "WaterWent");
import { drainStats, FULL_PCT } from "../lib/drainage";
import { Band, EVENT_ICON, EventKind, FIG, Glyph, raisedButton, SERVER_EVENT, serverEventLabel } from "./rev5";
import { TextField } from "./controls/TextField";
import { Menu } from "./controls/Menu";
import type { MenuEntry } from "./controls/Menu";
import { Tooltip, Tip } from "./controls/Tooltip";
import { Button } from "./controls/Button";

type Ev = { id: string; kind: EventKind; label: string; i: number; t: number; point?: [number, number] | null; place?: string | null };
type TS = NonNullable<RunManifest["timeseries"]>;
const SPEEDS = [300, 600, 1200];

/** Frame index closest to a time. */
const nearest = (ts: number[], t: number) => {
  let best = 0;
  ts.forEach((v, i) => { if (Math.abs(v - t) < Math.abs(ts[best] - t)) best = i; });
  return best;
};

function deriveEvents(ts: TS, rainStopS: number, server: RunEvents | null): Ev[] {
  const out: Ev[] = [];
  const add = (kind: EventKind, label: string, i: number, extra?: Partial<Ev>) => out.push({ id: `${kind}-${out.length}`, kind, label, i, t: ts.t_s[i], ...extra });
  if (server && server.events.length) {
    // Server events carry exact times and places; snap the chart marker to the nearest frame.
    server.events.forEach((e) => {
      const m = SERVER_EVENT[e.kind];
      if (m && e.t_s != null) add(m.kind, serverEventLabel(e), nearest(ts.t_s, e.t_s), { t: e.t_s, point: e.point, place: e.place });
    });
  } else {
    const cut = ts.edges_cut.findIndex((c) => c > 0);
    if (cut >= 0) add("cut", "First road impassable", cut);
    let surge = -1, jump = 0;
    ts.edges_cut.forEach((c, i) => { if (i && c - ts.edges_cut[i - 1] > jump) { jump = c - ts.edges_cut[i - 1]; surge = i; } });
    if (surge >= 0) add("surge", "Route cuts surge", surge);
    if (ts.flooded_area_km2.length) add("peak", "Peak flooded area", ts.flooded_area_km2.indexOf(Math.max(...ts.flooded_area_km2)));
  }
  add("rainstop", "Rain stops", nearest(ts.t_s, rainStopS));
  add("standing", "Water still standing", ts.t_s.length - 1);
  return out.sort((a, b) => a.t - b.t);
}

/** Round the top of a chart axis up to 1, 2, 2.5, 4, 5 or 10 times a power of ten. */
function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return (([1, 2, 2.5, 4, 5, 10].find((m) => m * p >= v) ?? 10) * p);
}
const tickLabel = (v: number) => String(+v.toFixed(2));
const TICK_PX = 11;  // --chart-tick is 10.5 px on a desktop, 11 on a phone or tablet

export function Chart({ series, color, playI, tTotal, width, height = 104, aria, gid, threshold, baseline, events = [], ymaxMin = 0, ghost, xTicks, span, yFmt }: {
  series: number[]; color: string; playI: number; tTotal: number; width: number; height?: number; aria: string; gid: string;
  threshold?: [number, string]; baseline?: [number, string]; events?: Ev[]; ymaxMin?: number;
  /** Compare mode: run A on the same frame times, drawn dashed in muted ink under run B. */
  ghost?: number[];
  /** Replaces the hour ticks: x labels and grid lines at these sample indices (the 3D close-up's ten minutes). */
  xTicks?: { i: number; label: string }[];
  /** A shaded stretch of the x axis between two sample indices, with a label (the close-up's settling time). */
  span?: { from: number; to: number; label: string };
  /** Formats y tick labels. */
  yFmt?: (v: number) => string;
}) {
  const W = width, H = height, L = 32, R = 6, T = 8, B = 20;
  const pw = W - L - R, ph = H - T - B, base = T + ph;
  const n = series.length;
  const ymax = niceMax(Math.max(ymaxMin, ...series, ...(ghost ?? [])));
  const yticks = [0, ymax / 2, ymax];
  const X = (i: number) => L + (pw * i) / Math.max(1, n - 1);
  const Y = (v: number) => T + ph * (1 - v / ymax);
  const pts = series.map((v, i) => [X(i), Y(v)] as const);
  const pi = Math.min(Math.max(playI, 0), n - 1);
  const path = (ps: (readonly [number, number])[]) => "M" + ps.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L");
  const past = pts.slice(0, pi + 1), fut = pts.slice(pi);
  const hours = Math.max(1, Math.round(tTotal / 3600));
  // x labels: every hour (or the given ticks), thinned so none overlap (board 13); the grid lines all stay.
  const xl = xTicks ?? Array.from({ length: hours + 1 }, (_, h) => ({ i: (h * (n - 1)) / hours, label: `T+${String(h).padStart(2, "0")}:00` }));
  const xAt = (tk: { i: number }) => (xTicks ? X(tk.i) : L + (pw * tk.i) / Math.max(1, n - 1));
  const shown = thinTicks(xl.map(xAt), xl.map((tk) => labelWidth(tk.label, TICK_PX)), pw).map((k) => xl[k]);
  const style = { display: "block", overflow: "visible", fontFamily: "var(--font-sans)", fontSize: "var(--chart-tick, 10.5px)", ...FIG } as const;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria} style={style}>
      <defs>
        <linearGradient id={`${gid}p`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.42" /><stop offset="1" stopColor={color} stopOpacity="0.06" /></linearGradient>
        <linearGradient id={`${gid}f`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.14" /><stop offset="1" stopColor={color} stopOpacity="0.02" /></linearGradient>
      </defs>
      {span && <>
        <rect x={X(span.from)} y={T} width={Math.max(0, X(span.to) - X(span.from))} height={ph} fill="var(--ink)" opacity="0.07" />
        <text x={X(span.from) + 6} y={T + 11} fill="var(--ink-muted)" fontSize="10">{span.label}</text>
      </>}
      {(xTicks ?? Array.from({ length: hours + 1 }, (_, h) => ({ i: (h * (n - 1)) / hours, label: "" }))).map((tk, k) => { const x = xTicks ? X(tk.i) : L + (pw * tk.i) / Math.max(1, n - 1); return <line key={k} x1={x} y1={T} x2={x} y2={base} stroke="var(--hairline)" strokeWidth="1" opacity="0.55" />; })}
      {yticks.map((v) => (
        <g key={v}>
          {v > 0 && <line x1={L} y1={Y(v)} x2={W - R} y2={Y(v)} stroke="var(--hairline)" strokeWidth="1" />}
          <text x={L - 6} y={Y(v) + 3.5} textAnchor="end" fill="var(--ink-muted)">{yFmt ? yFmt(v) : tickLabel(v)}</text>
        </g>
      ))}
      {ghost && ghost.length > 1 && <path d={path(ghost.map((v, i) => [X(i), Y(v)] as const))} fill="none" stroke="var(--ink-muted)" strokeWidth="1.5" strokeDasharray="3 3" />}
      {n > 1 && <>
        <path d={`${path(fut)} L${fut[fut.length - 1][0].toFixed(1)} ${base} L${fut[0][0].toFixed(1)} ${base} Z`} fill={`url(#${gid}f)`} />
        <path d={`${path(past)} L${past[past.length - 1][0].toFixed(1)} ${base} L${past[0][0].toFixed(1)} ${base} Z`} fill={`url(#${gid}p)`} />
        <path d={path(fut)} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6" />
        <path d={path(past)} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" />
      </>}
      {baseline && (
        // Level an intervention sets from t=0 (roads a planned pond closes): danfo, so the rise above it reads as flooding.
        <g>
          <line x1={L} y1={Y(baseline[0])} x2={W - R} y2={Y(baseline[0])} stroke="var(--danfo)" strokeWidth="1" strokeDasharray="2 2" />
          <text x={W - R} y={Y(baseline[0]) - 4} textAnchor="end" fill="var(--danfo-text)" fontSize="10">{baseline[1]}</text>
        </g>
      )}
      {threshold && (
        <g>
          <line x1={L} y1={Y(threshold[0])} x2={W - R} y2={Y(threshold[0])} stroke="var(--hazard)" strokeWidth="1" strokeDasharray="4 3" />
          <text x={L + 4} y={Y(threshold[0]) - 4} textAnchor="start" fill="var(--hazard)" fontSize="10">{threshold[1]}</text>
        </g>
      )}
      <line x1={L} y1={base} x2={W - R} y2={base} stroke="var(--control-edge)" strokeWidth="1" />
      {shown.map((tk, k) => (
        <text key={k} x={xAt(tk)} y={H - 5} textAnchor={k === 0 ? "start" : k === shown.length - 1 ? "end" : "middle"} fill="var(--ink-muted)">{tk.label}</text>
      ))}
      {events.map((e) => pts[e.i] && (
        <g key={e.id}>
          <line x1={pts[e.i][0]} y1={pts[e.i][1]} x2={pts[e.i][0]} y2={base} stroke={EVENT_ICON[e.kind].color} strokeWidth="1" strokeDasharray="2 2" opacity="0.7" />
          <circle cx={pts[e.i][0]} cy={pts[e.i][1]} r="3.5" fill={EVENT_ICON[e.kind].color} stroke="var(--surface)" strokeWidth="1.5" />
        </g>
      ))}
      {pts[pi] && <>
        <line x1={pts[pi][0]} y1={T - 2} x2={pts[pi][0]} y2={base} stroke="var(--danfo)" strokeWidth="1.5" />
        {([[T - 2, 3], [pts[pi][1], 4], [base, 3]] as const).map(([y, r], k) => <circle key={k} cx={pts[pi][0]} cy={y} r={r} fill="var(--surface)" stroke="var(--danfo)" strokeWidth="1.5" />)}
      </>}
    </svg>
  );
}

export type ChartPick = { label: string; on: boolean; onPick: () => void };

/** The ⋮ "Choose chart" of a dock slot whose figure has no chart actions (Compare's By place). */
export function ChartPicker({ menu }: { menu: ChartPick[] }) {
  return (
    <Menu label="Choose chart" items={menu.map((m): MenuEntry => ({ kind: "radio", label: m.label, checked: m.on, onSelect: m.onPick }))}
      trigger={(p) => (
        <button {...p} type="button" aria-label="Choose chart"
          style={{ display: "flex", padding: 2, background: "transparent", border: 0, borderRadius: 3, color: "var(--ink-muted)", cursor: "pointer" }}>
          <DotsThreeVertical size={14} weight="bold" />
        </button>
      )} />
  );
}

/** The area and run the charts show: the saved image's title and file name. App provides it. */
export const ChartArea = createContext<{ aoi: string; name: string; run?: string }>({ aoi: "map", name: "" });
const hiddenText: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };
const BLOCKED = "Couldn't copy. Your browser blocked the clipboard.";

export function ChartFigure({ title, unit, now, nowAt, ab, last, series, empty, menu, digits = 2, times, ...rest }: {
  title: string; unit: string; now: string; last?: boolean; series?: number[]; empty?: string;
  /** Muted context after the value ("at T+01:00"): the first thing dropped when the header is tight. */
  nowAt?: string;
  /** Compare mode: the A / B / change line, shown under the title in place of `now`. */
  ab?: ReactNode;
  /** The ⋮ button then picks which chart this slot shows. */
  menu?: ChartPick[];
  /** Decimals in the table and the CSV: the same as `now`. */
  digits?: number;
  /** The time of each sample, for the table (default: spread evenly over tTotal). */
  times?: number[];
} & Omit<React.ComponentProps<typeof Chart>, "series" | "width">) {
  const ref = useRef<HTMLDivElement>(null);
  const area = useContext(ChartArea);
  const [w, setW] = useState(0);
  const [table, setTable] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout>>();
  // Header (board 13): the title takes the free width and truncates (full title in a tooltip), the value stays whole
  // on the right and drops its "at T+…" first; a cell under 240 px puts the value on a line of its own, 18 px taller.
  const titleRef = useRef<HTMLSpanElement>(null), unitRef = useRef<HTMLSpanElement>(null), valRef = useRef<HTMLSpanElement>(null), atRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState({ at: true, cut: false });
  const twoLine = !ab && w > 0 && w + 28 < 240;
  useLayoutEffect(() => {
    const t = titleRef.current;
    if (!t || !w) return;
    const GAP = 5, MENU = 18;
    const titleW = t.scrollWidth, unitW = (unitRef.current?.offsetWidth ?? 0) + GAP;
    const valW = valRef.current?.offsetWidth ?? 0, atW = nowAt && atRef.current ? atRef.current.offsetWidth + GAP : 0;
    let at: boolean, room: number;
    if (ab) { at = false; room = w - unitW - MENU - GAP; }
    else if (twoLine) { at = valW + atW <= w; room = w - unitW - MENU - GAP; }
    else { at = titleW + unitW + valW + atW + MENU + 2 * GAP <= w; room = w - unitW - valW - (at ? atW : 0) - MENU - 2 * GAP; }
    const cut = titleW > room + 0.5;
    if (at !== fit.at || cut !== fit.cut) setFit({ at, cut });
  });
  const ch = (ab ? 84 : 104) - (twoLine ? 18 : 0);  // the A / B line takes the difference
  const hasData = !!series && series.length > 1;
  const showTable = table && hasData;
  const reason = empty ?? "No data to show yet";
  const data = series && hasData ? chartTable({ title, unit, digits, time: fmtT, series, ghost: rest.ghost,
    times: times ?? series.map((_, i) => (rest.tTotal * i) / (series.length - 1)) }) : null;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => clearTimeout(msgTimer.current), []);
  const say = (text: string, ms: number) => { clearTimeout(msgTimer.current); setMsg(text); msgTimer.current = setTimeout(() => setMsg(null), ms); };
  const copy = async () => {
    if (!data) return;
    try { await navigator.clipboard.writeText(chartCsv(data)); say("Copied", 1500); } catch { say(BLOCKED, 4000); }
  };
  const save = async () => {
    const svg = ref.current?.querySelector("svg");
    if (!svg) { say("Couldn't save the image.", 4000); return; }
    try {
      const url = await chartPng({ svg, title, area: area.name || area.aoi });
      const a = document.createElement("a");
      a.href = url;
      a.download = chartFilename(area.aoi, title, area.run);
      a.click();
    } catch { say("Couldn't save the image.", 4000); }
  };
  const actions: MenuEntry[] = [
    ...(menu ? [...menu.map((m): MenuEntry => ({ kind: "radio", label: m.label, checked: m.on, onSelect: m.onPick })), { kind: "separator" } as MenuEntry] : []),
    { kind: "item", label: showTable ? "Show as chart" : "Show as table", icon: <ChartBar size={14} weight="bold" />, disabled: !hasData, reason: hasData ? undefined : reason,
      onSelect: () => setTable((v) => !v) },
    { kind: "item", label: "Copy values", icon: <Copy size={14} weight="bold" />, disabled: !hasData, reason: hasData ? undefined : reason, onSelect: copy },
    { kind: "item", label: "Save chart image", icon: <Camera size={14} weight="bold" />, disabled: !hasData, reason: hasData ? undefined : reason, onSelect: save },
  ];
  return (
    <figure style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px 8px", minWidth: 0, overflow: "hidden", position: "relative", borderRight: last ? undefined : "1px solid var(--hairline)" }}>
      {nowAt && <span ref={atRef} aria-hidden="true" style={{ position: "absolute", visibility: "hidden", whiteSpace: "nowrap", pointerEvents: "none" }}>{nowAt}</span>}
      <figcaption style={{ display: "flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap", minWidth: 0 }}>
        {/* Each piece of text is its own box: the title truncates itself, the unit stays whole beside it. */}
        <Tip text={fit.cut ? `${title} (${unit})` : null}>
          <span ref={titleRef} style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600 }}>{title}</span>
        </Tip>
        <span ref={unitRef} style={{ flex: "none", color: "var(--ink-muted)" }}>({unit})</span>
        {!ab && !twoLine && <span style={{ flex: "none", marginLeft: "auto", fontWeight: 600, ...FIG }}><span ref={valRef}>{now}</span>{nowAt && fit.at && <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}> {nowAt}</span>}</span>}
        <span style={{ position: "relative", display: "flex", alignSelf: "center", flex: "none", marginLeft: ab || twoLine ? "auto" : undefined }}>
          <Menu label="Chart actions" items={actions}
            trigger={(p) => (
              <Button variant="icon" {...p} type="button" aria-label={menu ? "Choose chart" : "Chart actions"}
                style={{ display: "flex", padding: 2, background: "transparent", border: 0, borderRadius: 3, color: "var(--ink-muted)", cursor: "pointer" }}>
                <DotsThreeVertical size={14} weight="bold" />
              </Button>
            )} />
        </span>
      </figcaption>
      {twoLine && <span style={{ display: "block", height: 18, marginTop: -6, lineHeight: "18px", fontWeight: 600, whiteSpace: "nowrap", ...FIG }}><span ref={valRef}>{now}</span>{nowAt && fit.at && <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}> {nowAt}</span>}</span>}
      {ab}
      <div ref={ref} style={{ height: ch, position: "relative", minWidth: 0, overflow: showTable ? "auto" : undefined }}>
        {showTable && data && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, lineHeight: "16px", ...FIG }}>
            <caption style={hiddenText}>{title}</caption>
            <thead>
              <tr>{data.header.map((h, k) => (
                <th key={k} scope="col" style={{ position: "sticky", top: 0, background: "var(--surface)", padding: "4px 6px", fontWeight: 600, color: "var(--ink-muted)",
                  textAlign: k ? "right" : "left", borderBottom: "1px solid var(--hairline)", whiteSpace: "nowrap" }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i}>{r.map((c, k) => <td key={k} style={{ padding: "1px 6px", textAlign: k ? "right" : "left", whiteSpace: "nowrap" }}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        )}
        <div hidden={showTable}>
          {series && series.length > 1 && w > 60 ? <Chart series={series} width={w} height={ch} {...rest} />
            : <p style={{ margin: 0, height: ch, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 12 }}>{empty ?? "No data yet"}</p>}
        </div>
      </div>
      <span aria-live="polite" style={{ position: "absolute", top: 2, right: 14, fontSize: 12, color: "var(--ink-muted)", background: "var(--surface)", padding: "0 4px" }}>{msg}</span>
    </figure>
  );
}

/** A full-size depth chart that fills its box (Plan view's building dock); the clock drives the playhead. */
export function DepthChart({ series, ts, ghost, threshold }: { series: number[]; ts: number[]; ghost?: number[]; threshold?: [number, string] }) {
  const { t_s } = useClock();
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ flex: 1, minHeight: 120, padding: "10px 14px 6px", minWidth: 0 }}>
      {box.w > 60 && <Chart series={series} ghost={ghost} color="var(--depth-3)" gid="bd" playI={nearest(ts, t_s)} tTotal={ts[ts.length - 1]} width={box.w - 28} height={Math.max(104, box.h - 16)}
        ymaxMin={0.5} threshold={threshold} aria="Depth beside the selected building over time" />}
    </div>
  );
}

const sq: React.CSSProperties = { height: 30, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, borderRadius: "var(--radius-md)" };

function Timeline({ ts, events, durS, rainStopS, nowS, playing, speed, note }: { ts: TS; events: Ev[]; durS: number; rainStopS: number; nowS: number; playing: boolean; speed: number; note?: string }) {
  const pct = (t: number) => (100 * t) / durS;
  const ph = pct(nowS);
  const track = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(0);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setTrackW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const seek = (e: PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    clock.set({ t_s: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * durS, playing: false });
  };
  const frames = ts.t_s.length;
  const stepMin = frames > 1 ? Math.round((ts.t_s[1] - ts.t_s[0]) / 60) : 0;
  const fa = ts.flooded_area_km2, fmax = Math.max(...fa, 1e-9);
  const stops = fa.map((v, i) => `color-mix(in srgb, var(--depth-3) ${Math.round((55 * v) / fmax)}%, transparent) ${(100 * i / Math.max(1, frames - 1)).toFixed(2)}%`).join(",");
  const hours = Math.floor(durS / 3600);
  // Hour labels thinned to fit the track (the same rule as the charts); a run that ends on the hour ends its last label there.
  const endsOnHour = hours * 3600 >= durS;
  const hourLabels = Array.from({ length: hours + 1 }, (_, h) => h);
  const shownHours = trackW ? thinTicks(hourLabels.map((h) => (trackW * h * 3600) / durS), hourLabels.map(() => labelWidth("T+00:00", 11)), trackW,
    hourLabels.map((h) => (h === 0 ? "start" : h === hours && endsOnHour ? "end" : "middle"))).map((k) => hourLabels[k]) : [];
  const nextEvent = () => { const e = events.find((x) => x.t > nowS + 1); clock.set({ t_s: e ? e.t : 0, playing: false }); };
  const ico = { play: <path d="M3 1.8v8.4L10 6z" fill="currentColor" />, pause: <><rect x="2.5" y="2" width="2.5" height="8" rx=".5" fill="currentColor" /><rect x="7" y="2" width="2.5" height="8" rx=".5" fill="currentColor" /></>,
    next: <><path d="M2 2v8l6-4z" fill="currentColor" /><rect x="8.5" y="2" width="1.8" height="8" rx=".5" fill="currentColor" /></> };
  const svg12 = (c: React.ReactNode) => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">{c}</svg>;
  const pressed = { background: "var(--pressed-bg)", color: "var(--ground)", border: "1px solid var(--ink)", boxShadow: "var(--pressed-shadow)" };
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <Band title="Timeline" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>{note ?? <><span style={{ fontFamily: "var(--font-mono)" }}>T+00:00 – {fmtT(durS)}</span> · {frames} frames, {stepMin} min</>}</span>} />
      <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: 18, alignItems: "center", padding: "14px 18px 10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Button variant="raised" type="button" aria-label="Play" style={{ ...sq, width: 30, ...raisedButton }} onClick={() => clock.set(nowS >= durS ? { t_s: 0, playing: true } : { playing: true })}>{svg12(ico.play)}</Button>
          <Button variant="raised" type="button" aria-label="Pause" aria-pressed={!playing} style={{ ...sq, width: 30, ...(!playing ? pressed : raisedButton) }} onClick={() => clock.set({ playing: false })}>{svg12(ico.pause)}</Button>
          <Button variant="raised" type="button" aria-label="Next event" style={{ ...sq, width: 30, ...raisedButton }} onClick={nextEvent}>{svg12(ico.next)}</Button>
          <span style={{ width: 4 }} />
          <Button variant="raised" type="button" aria-label="Playback speed" onClick={() => clock.set({ speed: SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] })}
            style={{ ...sq, gap: 6, padding: "0 8px 0 10px", ...raisedButton, font: "inherit", ...FIG }}>{speed}×<CaretDown size={12} weight="bold" color="var(--ink-muted)" /></Button>
        </div>
        <div ref={track} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e); }}
          onPointerMove={(e) => { if (e.buttons) seek(e); }} style={{ position: "relative", height: 66, cursor: "pointer", touchAction: "none" }}>
          <span style={{ position: "absolute", left: `${ph}%`, top: -6, transform: "translateX(-50%)", padding: "2px 8px", background: "var(--ink)", color: "var(--ground)", borderRadius: "var(--radius-md)",
            fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: "16px", fontWeight: 500, whiteSpace: "nowrap" }}>{fmtT(nowS)}</span>
          <div style={{ position: "absolute", left: 0, right: 0, top: 22, height: 4, background: "var(--ground)", borderRadius: "var(--radius-pill)", boxShadow: "var(--inset-shadow)" }} />
          <div style={{ position: "absolute", left: 0, width: `${ph}%`, top: 23, height: 2, background: "var(--ink)", borderRadius: "var(--radius-pill)", marginLeft: 1 }} />
          <Tooltip text="Flooded area per frame"><div style={{ position: "absolute", left: 0, right: 0, top: 31, height: 4, borderRadius: "var(--radius-pill)", background: `linear-gradient(90deg, ${stops})` }} /></Tooltip>
          <Tooltip text={`Rain falling, T+00:00 to ${fmtT(rainStopS)}`}><div style={{ position: "absolute", left: 0, width: `${pct(rainStopS)}%`, top: 29, height: 5, borderBottom: "1px dashed var(--ink-muted)", opacity: 0.6 }} /></Tooltip>
          <span style={{ position: "absolute", left: `${ph}%`, top: 17, width: 14, height: 14, marginLeft: -7, borderRadius: "50%", background: "var(--ground)", border: "3px solid var(--danfo)",
            boxShadow: "0 0 0 4px color-mix(in srgb, var(--danfo) 22%, transparent), 0 2px 4px var(--elev-drop)" }} />
          <div style={{ position: "absolute", left: 0, right: 0, top: 38 }}>
            {events.filter((e) => e.kind !== "standing" && e.kind !== "peak").map((e) => (
              <Tip key={e.id} text={e.label}><span style={{ position: "absolute", left: `${pct(e.t)}%`, top: 0, transform: "translateX(-50%)", display: "flex" }}><Glyph kind={e.kind} muted={e.t > nowS} /></span></Tip>
            ))}
          </div>
          <div style={{ position: "absolute", left: 0, right: 0, top: 54 }}>
            <div style={{ position: "relative", height: 0 }}>
              {Array.from({ length: Math.floor(durS / 600) + 1 }, (_, k) => (
                <span key={k} style={{ position: "absolute", left: `${(100 * k * 600) / durS}%`, top: 0, width: 1, height: k % 6 === 0 ? 7 : 4, background: k % 6 === 0 ? "var(--control-edge)" : "var(--hairline)" }} />
              ))}
            </div>
          </div>
          <div style={{ position: "absolute", left: 0, right: 0, top: 52, height: 18 }}>
            {shownHours.map((h) => (
              <span key={h} style={{ position: "absolute", left: `${(100 * h * 3600) / durS}%`, top: 10, transform: `translateX(${h === 0 ? "0" : h * 3600 >= durS ? "-100%" : "-50%"})`, fontSize: 11, whiteSpace: "nowrap",
                color: h * 3600 <= nowS ? "var(--ink)" : "var(--ink-muted)", ...FIG }}>T+{String(h).padStart(2, "0")}:00</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const NOTE_MAX = 200;

function KeyEvents({ events, nowS, runId, extra }: { events: Ev[]; nowS: number; runId?: string; /** Before + Note in the band. */ extra?: ReactNode }) {
  const sel = [...events].reverse().find((e) => e.t <= nowS)?.id;
  const notes = useNotes(runId);
  const [draft, setDraft] = useState<{ t: number; text: string } | null>(null);
  useEffect(() => setDraft(null), [runId]);
  const save = () => {
    const text = draft?.text.trim();
    if (runId && draft && text) addNote(runId, draft.t, text.slice(0, NOTE_MAX));
    setDraft(null);
  };
  // Events and notes share one list, in time order.
  const rows = [...events.map((e) => ({ t: e.t, e })), ...notes.map((n) => ({ t: n.t_s, n }))].sort((a, b) => a.t - b.t);
  const seek = (t: number) => clock.set({ t_s: t, playing: false });
  return (
    <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid var(--hairline)", minHeight: 0, background: "var(--surface)" }}>
      <Band title="Key events" right={<>{extra}
        <Tooltip text={runId ? `Add a note at ${fmtT(nowS)}` : "Run a simulation to add notes"}><Button variant="raised" type="button" data-tour="marks" disabled={!runId}
          onClick={() => { clock.set({ playing: false }); setDraft({ t: nowS, text: "" }); }}
          style={{ marginLeft: "auto", height: 26, display: "flex", alignItems: "center", gap: 5, padding: "0 9px 0 7px", ...raisedButton, borderRadius: "var(--radius-md)", font: "inherit", fontSize: 12, fontWeight: 500 }}>
          <Plus size={12} weight="bold" />Note</Button></Tooltip></>} />
      {draft && (
        <div style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) auto", gap: 10, alignItems: "center", minHeight: 36, padding: "0 12px 0 14px", borderBottom: "1px solid var(--hairline)" }}>
          <NotePencil size={14} weight="bold" color="var(--ink-muted)" />
          <TextField autoFocus value={draft.text} maxLength={NOTE_MAX} placeholder="Note, then Enter" aria-label={`Note at ${fmtT(draft.t)}`}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape") { e.preventDefault(); setDraft(null); } }}
            onBlur={() => setDraft(null)}
            style={{ minWidth: 0, height: 26, padding: "0 8px", fontSize: 12 }} />
          <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{fmtT(draft.t)}</span>
        </div>
      )}
      <ol style={{ margin: "4px 0 0", padding: 0, listStyle: "none", minHeight: 0, overflowY: "auto" }}>
        {rows.map((r) => {
          if ("n" in r && r.n) {
            const n = r.n, fut = n.t_s > nowS;
            return (
              <Tooltip key={`note-${n.id}`} text={n.text}><li className="dr-row" onClick={() => seek(n.t_s)}
                style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) auto 20px", gap: 10, alignItems: "center", height: 32, padding: "0 8px 0 14px", cursor: "pointer",
                  ...(fut ? { color: "var(--ink-muted)" } : {}) }}>
                <NotePencil size={14} weight="bold" color="var(--ink-muted)" />
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.text}</span>
                <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{fmtT(n.t_s)}</span>
                <Tooltip text="Remove note"><Button variant="icon" type="button" aria-label={`Remove note at ${fmtT(n.t_s)}`} onClick={(ev) => { ev.stopPropagation(); if (runId) removeNote(runId, n.id); }}
                  style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, background: "transparent", border: 0, borderRadius: 3, color: "var(--ink-muted)", cursor: "pointer" }}>
                  <X size={12} weight="bold" />
                </Button></Tooltip>
              </li></Tooltip>
            );
          }
          const e = (r as { e: Ev }).e;
          const fut = e.t > nowS, on = e.id === sel;
          return (
            <Tip key={e.id} text={e.place ?? undefined}><li className="dr-row" onClick={() => { seek(e.t); if (e.point) setFocus({ lon: e.point[0], lat: e.point[1] }); }}
              style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) auto", gap: 10, alignItems: "center", height: 32, padding: "0 12px 0 14px", cursor: "pointer",
                ...(on ? { background: "var(--surface-raised)", boxShadow: "inset 3px 0 0 var(--danfo), inset 0 1px 0 var(--elev-hi), 0 1px 2px var(--elev-drop-soft)" } : {}), ...(fut ? { color: "var(--ink-muted)" } : {}) }}>
              <Glyph kind={e.kind} muted={fut} /><span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...(on ? { fontWeight: 600 } : {}) }}>{e.label}</span>
              <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{fmtT(e.t)}</span>
            </li></Tip>
          );
        })}
      </ol>
      <p style={{ margin: "auto 14px 10px", paddingTop: 6, color: "var(--ink-muted)", fontSize: 11, lineHeight: "15px" }}>Greyed events are after the playhead. Notes stay in this browser.</p>
    </div>
  );
}

/** Compare header: "A 20.81  B 3.66  −82%" at the playhead. */
function abNow(a: number, b: number, digits: number) {
  const p = a > 0 ? Math.round((100 * (b - a)) / a) : null;
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: -2, fontWeight: 600, whiteSpace: "nowrap", ...FIG }}>
      <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>A {a.toFixed(digits)}</span>B {b.toFixed(digits)}
      {p != null && <span style={{ color: p < 0 ? "var(--verified)" : p > 0 ? "var(--hazard)" : "var(--ink-muted)" }}>{p > 0 ? "+" : p < 0 ? "−" : ""}{Math.abs(p)}%</span>}
    </span>
  );
}

type RainStorm = { total_mm: number; duration_h: number; pattern?: "uniform" | "front_loaded" | "center_peaked" };

/** Before a run, with a rain area set: the rain at the storm centre over time, and the preview depth inside each place. */
function RainDock({ storm, now, layout = "row" }: { storm: RainStorm; now?: ReactNode; layout?: DockLayout }) {
  const r = useRain();
  const f = r.preview;
  const [rows, setRows] = useState<{ name: string; mm: number }[]>([]);
  useEffect(() => {
    if (!f || !r.places.length) { setRows([]); return; }
    let off = false;
    depthByPlace(f, r.places).then((x) => { if (!off) setRows(x); }, () => { if (!off) setRows([]); });
    return () => { off = true; };
  }, [f?.png, r.places]);
  const series = useMemo(() => hyetograph(storm.total_mm, storm.duration_h, storm.pattern ?? "uniform"), [storm.total_mm, storm.duration_h, storm.pattern]);
  const moving = isCell(r) && r.moving;
  const shell = dockShell(layout);
  return (
    <div data-tour={layout === "extras" ? undefined : "timeline"} style={shell}>
      {layout !== "extras" && <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Band title="Rain at the storm centre" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}>
          mm/h{moving ? " · moving cell, so the centre is where the storm is at each moment" : ""}</span>} />
        <ChartFigure last title="Rain intensity" unit="mm/h" digits={0} now={`${Math.max(...series).toFixed(0)} peak`} series={series} color="var(--depth-3)" gid="rn" playI={-1} ymaxMin={Math.max(...series) * 1.2} tTotal={storm.duration_h * 3600}
          aria="Rain intensity at the storm centre over the storm duration" />
      </div>}
      {layout !== "two" && (now ?? <div style={{ display: "flex", flexDirection: "column", borderLeft: layout === "row" ? "1px solid var(--hairline)" : undefined, minHeight: 0 }}>
        <Band title="Where it rains" />
        {rows.length === 0 ? <p style={{ margin: 0, padding: 14, color: "var(--ink-muted)", fontSize: 12 }}>{r.places.length ? "Waiting for the preview" : "No places in this area"}</p> : (
          <ol style={{ margin: "4px 0 0", padding: 0, listStyle: "none", minHeight: 0, overflowY: "auto" }}>
            {rows.map((p) => (
              <li key={p.name} onClick={() => { const pl = r.places.find((x) => x.name === p.name); if (pl) setFocus({ lon: pl.lon, lat: pl.lat }); }}
                style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center", height: 32, padding: "0 12px 0 14px", cursor: "pointer" }}>
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{Math.round(p.mm)} mm</span>
              </li>
            ))}
          </ol>
        )}
      </div>)}
    </div>
  );
}

/** Where the dock is drawn (board 13). "row": desktop, the charts in a row and key events at the right. "two": a tablet,
 *  under the map, the timeline and two charts. "extras": the tablet drawer's Timeline tab, what "two" leaves out (the
 *  third chart and key events). "stack": the phone Timeline sheet, every chart full width with key events below. */
type SlotKey = "fa" | "rk" | "dn" | "dp" | "x";
const SLOT_MIN = 220;
const SLOTS_KEY = "dr_dock_charts";
const readSlots = (): SlotKey[] | null => {
  try { const v = JSON.parse(sessionStorage.getItem(SLOTS_KEY) ?? "null"); return Array.isArray(v) ? v : null; } catch { return null; }
};
const writeSlots = (v: SlotKey[]) => { try { sessionStorage.setItem(SLOTS_KEY, JSON.stringify(v)); } catch { /* private mode: this view only */ } };

export type DockLayout = "row" | "two" | "extras" | "stack";
const dockShell = (layout: DockLayout): CSSProperties => (layout === "row"
  ? { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 248px", background: "var(--surface)", borderTop: "1px solid var(--hairline)", minHeight: 0 }
  : layout === "two" ? { display: "flex", flexDirection: "column", background: "var(--surface)", borderTop: "1px solid var(--hairline)", minHeight: 0 }
  : { display: "flex", flexDirection: "column", background: "var(--surface)", minHeight: 0, border: layout === "extras" ? "1px solid var(--hairline)" : undefined,
    borderRadius: layout === "extras" ? 6 : undefined, overflow: layout === "extras" ? "hidden" : undefined });

export function Dock({ storm, run, series, ghost, third, thirdLabel, side, note, layout = "row" }: { storm?: RainStorm; run?: RunManifest; /** Depth in metres at the selected map point, one value per frame. */ series?: number[];
  layout?: DockLayout;
  /** Compare mode: run A, drawn under `run` (B) in the charts. */ ghost?: RunManifest;
  /** Replace the third chart and the Key events column; `note` replaces the timeline's frame summary. The third chart
   *  is given the slot's "Choose chart" picks when the dock has room for fewer than three. */
  third?: ReactNode | ((menu?: ChartPick[]) => ReactNode); /** The third chart's name in the pickers. */ thirdLabel?: string;
  side?: ReactNode; note?: string }) {
  const { t_s, playing, speed } = useClock();
  const ts = run?.timeseries ?? null;
  // Drainage runs: the third chart can show the drain network, and the side panel where the water went (shown first).
  const [thirdPick, setThirdPick] = useState<"drains" | "depth">(() => (readSlots()?.find((k) => k === "dn" || k === "dp") === "dp" ? "depth" : "drains"));
  // Desktop: as many charts as fit at 220 px each, 1 to 3 (board 13); each slot's ⋮ then picks its chart.
  const [chartBox, setChartBox] = useState<HTMLDivElement | null>(null);
  const [slots, setSlots] = useState(3);
  const [order, setOrder] = useState<SlotKey[]>(() => readSlots() ?? []);
  useEffect(() => {
    if (!chartBox) return;
    const ro = new ResizeObserver(([e]) => setSlots(Math.max(1, Math.min(3, Math.floor(e.contentRect.width / SLOT_MIN)))));
    ro.observe(chartBox);
    return () => ro.disconnect();
  }, [chartBox]);
  const [sidePick, setSidePick] = useState<"water" | "events">("water");
  const rainStopS = (run?.scenario.storm.duration_h ?? 3) * 3600;
  const lay = useLayers();
  const { events: serverEvents } = useExtras();
  const srv = serverEvents && serverEvents.run_id === run?.run_id ? serverEvents : null;
  const events = useMemo(() => (ts && ts.t_s.length > 1 ? deriveEvents(ts, rainStopS, srv) : []), [ts, rainStopS, srv]);
  const pond = srv?.events.find((e) => e.kind === "pond_closure");
  const pondKm = pond ? (pond.road_km ?? ts?.road_km_impassable[0] ?? null) : null;
  const shell = dockShell(layout);
  const rainSet = useRain();
  // While a run simulates, or the finished run plays with "Clouds and rain" on, the side panel is Rain now.
  const wsrc = useWeatherSource(run);
  const rainNow = wsrc ? <RainNow src={wsrc} /> : null;
  if ((!ts || ts.t_s.length < 2) && storm && rainSet.mode !== "whole" && rainSet.visible) return <RainDock storm={storm} now={rainNow ?? undefined} layout={layout} />;
  if (!ts || ts.t_s.length < 2) {
    const empty = <p style={{ margin: 0, padding: 18, color: "var(--ink-muted)" }}>Run a simulation to see the timeline and charts.</p>;
    if (layout === "stack") return <div data-tour="timeline" style={shell}>{empty}{rainNow}</div>;
    if (layout === "extras") return <div style={shell}>{rainNow ?? <KeyEvents events={[]} nowS={0} />}</div>;
    return <div data-tour="timeline" style={shell}><div style={{ display: "flex", flexDirection: "column" }}><Band title="Timeline" />{empty}</div>
      {layout === "row" && (rainNow ?? <KeyEvents events={[]} nowS={0} />)}</div>;
  }
  const durS = ts.t_s[ts.t_s.length - 1];
  const pi = nearest(ts.t_s, t_s);
  const chartEvents = events.filter((e) => e.kind === "cut" || e.kind === "surge");
  const common = { playI: pi, tTotal: durS, times: ts.t_s };
  const dp = series && series.length > 1 ? series : undefined;
  // Run A on B's frame times (nearest frame), so both lines share one x axis and one playhead.
  const gts = ghost?.timeseries;
  const onB = (k: "flooded_area_km2" | "road_km_impassable") => (gts && gts.t_s.length > 1 ? ts.t_s.map((t) => gts[k][nearest(gts.t_s, t)]) : undefined);
  const gfa = onB("flooded_area_km2"), grk = onB("road_km_impassable");
  const ds = !ghost ? drainSeries(ts) : null;
  const menu = ds ? [{ label: "Drain network running full", on: thirdPick === "drains", onPick: () => setThirdPick("drains") },
    { label: "Depth at selected point", on: thirdPick !== "drains", onPick: () => setThirdPick("depth") }] : undefined;
  const water = !ghost && drainStats(run) != null;
  const runKey = run?.status === "done" ? run.run_id : undefined;
  const events$ = (extra?: ReactNode) => <KeyEvents events={events} nowS={t_s} runId={runKey} extra={extra} />;
  const eventsOrWater = water && run && sidePick === "water" ? <WaterWent run={run} onEvents={() => setSidePick("events")} />
    : events$(water ? <SideSwitch to="water" onClick={() => setSidePick("water")} /> : undefined);
  const sidePanel = side ?? (lay.loads.on && !ghost ? <LoadsPanel /> : rainNow && wsrc?.live ? rainNow : rainNow
    ? <div style={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", minHeight: 0 }}>
        {rainNow}{eventsOrWater}
      </div>
    : eventsOrWater);
  const narrow = layout !== "row";
  const thirdKey: SlotKey = third ? "x" : ds && thirdPick === "drains" ? "dn" : "dp";
  const avail: SlotKey[] = ["fa", "rk", ...(third ? ["x" as const] : ds ? ["dn" as const, "dp" as const] : ["dp" as const])];
  const label: Record<SlotKey, string> = { fa: "Flooded area", rk: "Roads impassable", dn: "Drain network running full", dp: "Depth at selected point", x: thirdLabel ?? "Third chart" };
  // Fewer than three slots: the remembered order (this session), then the default (flooded area, roads, drains).
  const fewer = layout === "row" && slots < 3;
  const shownKeys: SlotKey[] = fewer
    ? [...order.filter((k) => avail.includes(k)), "fa", "rk", thirdKey].filter((k, i, a) => a.indexOf(k) === i).slice(0, slots) as SlotKey[]
    : ["fa", "rk", thirdKey];
  const choose = (slot: number, k: SlotKey) => {
    const next = [...shownKeys, ...avail.filter((a) => !shownKeys.includes(a))];
    const j = next.indexOf(k);
    [next[slot], next[j]] = [next[j], next[slot]];
    setOrder(next);
    writeSlots(next);
    if (k === "dn" || k === "dp") setThirdPick(k === "dn" ? "drains" : "depth");
  };
  const picks = (slot: number): ChartPick[] => avail.map((k) => ({ label: label[k], on: shownKeys[slot] === k, onPick: () => choose(slot, k) }));
  // Three slots: only the third picks (drain network or depth), as before.
  const thirdMenu = ds ? [{ label: label.dn, on: thirdPick === "drains", onPick: () => { setThirdPick("drains"); writeSlots(["fa", "rk", "dn"]); } },
    { label: label.dp, on: thirdPick !== "drains", onPick: () => { setThirdPick("depth"); writeSlots(["fa", "rk", "dp"]); } }] : undefined;
  const chart = (k: SlotKey, last: boolean, menu?: ChartPick[]): ReactNode => {
    if (k === "fa") return <ChartFigure key="fa" last={last} title="Flooded area" unit="km²" digits={2} now={ts.flooded_area_km2[pi].toFixed(2)} ab={gfa && abNow(gfa[pi], ts.flooded_area_km2[pi], 2)} ghost={gfa} series={ts.flooded_area_km2} color="var(--depth-3)" gid="fa" events={chartEvents} menu={menu} {...common}
      aria={`Flooded area over time; ${ts.flooded_area_km2[pi].toFixed(2)} square kilometres at the playhead, ${fmtT(t_s)}`} />;
    if (k === "rk") return <ChartFigure key="rk" last={last} title="Roads impassable" unit="km" digits={1} now={ts.road_km_impassable[pi].toFixed(1)} ab={grk && abNow(grk[pi], ts.road_km_impassable[pi], 1)} ghost={grk} series={ts.road_km_impassable} color="var(--hazard)" gid="rk" events={chartEvents} baseline={pondKm != null ? [pondKm, `${pondKm.toFixed(1)} km closed by the planned pond`] : undefined} menu={menu} {...common}
      aria={`Impassable road length over time; ${ts.road_km_impassable[pi].toFixed(1)} kilometres at the playhead`} />;
    if (k === "x") return <div key="x" style={{ display: "flex", flexDirection: "column", minWidth: 0, borderRight: last ? undefined : "1px solid var(--hairline)" }}>{typeof third === "function" ? third(menu) : third}</div>;
    if (k === "dn" && ds) return <ChartFigure key="dn" last={last} title="Drain network running full" unit="%" digits={0} now={`${Math.round(ds[Math.min(pi, ds.length - 1)] ?? 0)}`} nowAt={`at ${fmtT(ts.t_s[pi])}`} series={ds} menu={menu}
      color="var(--depth-3)" gid="dn" ymaxMin={100} threshold={[FULL_PCT, `Full ${FULL_PCT} %`]} {...common}
      aria={`Share of the drain network running full over time; ${Math.round(ds[Math.min(pi, ds.length - 1)] ?? 0)} % at the playhead`} />;
    return <ChartFigure key="dp" last={last} title="Depth at selected point" unit="m" digits={2} now={dp ? (dp[Math.min(pi, dp.length - 1)] ?? 0).toFixed(2) : "–"} series={dp} empty="Pick a point on the map" menu={menu}
      color="var(--depth-3)" gid="dp" ymaxMin={0.5} threshold={[0.3, "Impassable 0.30 m"]} {...common} aria="Depth at the selected map point over time" />;
  };
  const charts = [chart("fa", narrow), chart("rk", layout === "two" ? true : narrow), chart(thirdKey, true, thirdMenu)];
  const profile = lay.profile.on && !ghost;
  // Narrow layouts: one chart per row, a hairline between them; the side panel then reads as a full-width list.
  const rows = (cs: ReactNode[]) => cs.map((c, k) => <div key={k} style={{ borderTop: k || layout !== "extras" ? "1px solid var(--hairline)" : undefined, minWidth: 0 }}>{c}</div>);
  const sideBlock = <div className="dr-dock-side" style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--hairline)", minHeight: 0 }}>{sidePanel}</div>;
  if (layout === "stack") {
    return <div data-tour="timeline" style={shell}>{profile ? <ProfileDock /> : rows(charts)}{sideBlock}</div>;
  }
  if (layout === "extras") return <div style={shell}>{!profile && rows([charts[2]])}{sideBlock}</div>;
  if (layout === "two") {
    return (
      <div data-tour="timeline" style={shell}>
        <Timeline ts={ts} events={events} durS={durS} rainStopS={rainStopS} nowS={t_s} playing={playing} speed={speed} note={note ?? (!ghost ? drainNote(run) : undefined)} />
        {profile ? <ProfileDock /> : <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", borderTop: "1px solid var(--hairline)", minHeight: 0 }}>
          {charts[0]}<div style={{ borderLeft: "1px solid var(--hairline)", minWidth: 0 }}>{charts[1]}</div></div>}
      </div>
    );
  }
  return (
    <div data-tour="timeline" style={shell}>
      <div style={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", minWidth: 0 }}>
        <Timeline ts={ts} events={events} durS={durS} rainStopS={rainStopS} nowS={t_s} playing={playing} speed={speed} note={note ?? (!ghost ? drainNote(run) : undefined)} />
        {profile ? <ProfileDock /> : <div ref={setChartBox} style={{ display: "grid", gridTemplateColumns: `repeat(${shownKeys.length}, minmax(0, 1fr))`, borderTop: "1px solid var(--hairline)", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
          {fewer ? shownKeys.map((k, i) => chart(k, i === shownKeys.length - 1, picks(i))) : charts}
        </div>}
      </div>
      {sidePanel}
    </div>
  );
}
