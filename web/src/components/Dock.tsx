// Dock (rev 5 dock()): timeline, three charts, key events. Everything reads the one clock.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { CaretDown, DotsThreeVertical, NotePencil, Plus, X } from "@phosphor-icons/react";
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
const LoadsPanel = lazyNamed(() => import("./FlowHazard"), "LoadsPanel");
const ProfileDock = lazyNamed(() => import("./FlowHazard"), "ProfileDock");
import { drainNote, drainSeries } from "../lib/drainage";
const SideSwitch = lazyNamed(() => import("./Drainage"), "SideSwitch");
const WaterWent = lazyNamed(() => import("./Drainage"), "WaterWent");
import { drainStats, FULL_PCT } from "../lib/drainage";
import { Band, EVENT_ICON, EventKind, FIG, Glyph, raisedButton, SERVER_EVENT, serverEventLabel } from "./rev5";

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
  const xl = [0, 1, 2, 3].map((k) => Math.round((hours * k) / 3)).filter((h, k, a) => a.indexOf(h) === k);
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
      {xTicks ? xTicks.map((tk, k) => (
        <text key={k} x={X(tk.i)} y={H - 5} textAnchor={k === 0 ? "start" : k === xTicks.length - 1 ? "end" : "middle"} fill="var(--ink-muted)">{tk.label}</text>
      )) : xl.map((h, k) => (
        <text key={h} x={L + (pw * h) / hours} y={H - 5} textAnchor={k === 0 ? "start" : h === hours ? "end" : "middle"} fill="var(--ink-muted)">T+{String(h).padStart(2, "0")}:00</text>
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

export function ChartFigure({ title, unit, now, ab, last, series, empty, menu, ...rest }: {
  title: string; unit: string; now: string; last?: boolean; series?: number[]; empty?: string;
  /** Compare mode: the A / B / change line, shown under the title in place of `now`. */
  ab?: ReactNode;
  /** The ⋮ button then picks which chart this slot shows. */
  menu?: ChartPick[];
} & Omit<React.ComponentProps<typeof Chart>, "series" | "width">) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [open, setOpen] = useState(false);
  const ch = ab ? 84 : 104;  // the A / B line takes the difference
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <figure style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px 8px", minWidth: 0, borderRight: last ? undefined : "1px solid var(--hairline)" }}>
      <figcaption style={{ display: "flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 600 }}>{title}</span><span style={{ color: "var(--ink-muted)" }}>({unit})</span>
        {!ab && <span style={{ marginLeft: "auto", fontWeight: 600, ...FIG }}>{now}</span>}
        {menu ? (
          <span style={{ position: "relative", display: "flex", alignSelf: "center" }}>
            <button type="button" aria-label="Choose chart" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
              onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setOpen(false); }}
              style={{ display: "flex", padding: 2, background: "transparent", border: 0, borderRadius: 3, color: "var(--ink-muted)", cursor: "pointer" }}><DotsThreeVertical size={14} weight="bold" /></button>
            {open && (
              <span role="menu" style={{ position: "absolute", right: 0, top: 22, zIndex: 5, display: "flex", flexDirection: "column", padding: 4, background: "var(--surface-raised)",
                border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)" }}>
                {menu.map((m) => (
                  <button key={m.label} type="button" role="menuitemradio" aria-checked={m.on} onClick={() => { m.onPick(); setOpen(false); }}
                    style={{ height: 28, padding: "0 10px", textAlign: "left", whiteSpace: "nowrap", background: m.on ? "var(--ground)" : "transparent", border: 0, borderRadius: 3,
                      color: "var(--ink)", font: "inherit", fontSize: 12, fontWeight: m.on ? 600 : 400, cursor: "pointer" }}>{m.label}</button>
                ))}
              </span>
            )}
          </span>
        ) : <span style={{ display: "flex", alignSelf: "center", color: "var(--ink-muted)" }}><DotsThreeVertical size={14} weight="bold" /></span>}
      </figcaption>
      {ab}
      <div ref={ref} style={{ height: ch, position: "relative", minWidth: 0 }}>
        {series && series.length > 1 && w > 60 ? <Chart series={series} width={w} height={ch} {...rest} />
          : <p style={{ margin: 0, height: ch, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 12 }}>{empty ?? "No data yet"}</p>}
      </div>
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
  const seek = (e: PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    clock.set({ t_s: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * durS, playing: false });
  };
  const frames = ts.t_s.length;
  const stepMin = frames > 1 ? Math.round((ts.t_s[1] - ts.t_s[0]) / 60) : 0;
  const fa = ts.flooded_area_km2, fmax = Math.max(...fa, 1e-9);
  const stops = fa.map((v, i) => `color-mix(in srgb, var(--depth-3) ${Math.round((55 * v) / fmax)}%, transparent) ${(100 * i / Math.max(1, frames - 1)).toFixed(2)}%`).join(",");
  const hours = Math.floor(durS / 3600);
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
          <button type="button" aria-label="Play" style={{ ...sq, width: 30, ...raisedButton }} onClick={() => clock.set(nowS >= durS ? { t_s: 0, playing: true } : { playing: true })}>{svg12(ico.play)}</button>
          <button type="button" aria-label="Pause" aria-pressed={!playing} style={{ ...sq, width: 30, ...(!playing ? pressed : raisedButton) }} onClick={() => clock.set({ playing: false })}>{svg12(ico.pause)}</button>
          <button type="button" aria-label="Next event" style={{ ...sq, width: 30, ...raisedButton }} onClick={nextEvent}>{svg12(ico.next)}</button>
          <span style={{ width: 4 }} />
          <button type="button" aria-label="Playback speed" onClick={() => clock.set({ speed: SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] })}
            style={{ ...sq, gap: 6, padding: "0 8px 0 10px", ...raisedButton, font: "inherit", ...FIG }}>{speed}×<CaretDown size={12} weight="bold" color="var(--ink-muted)" /></button>
        </div>
        <div ref={track} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e); }}
          onPointerMove={(e) => { if (e.buttons) seek(e); }} style={{ position: "relative", height: 66, cursor: "pointer", touchAction: "none" }}>
          <span style={{ position: "absolute", left: `${ph}%`, top: -6, transform: "translateX(-50%)", padding: "2px 8px", background: "var(--ink)", color: "var(--ground)", borderRadius: "var(--radius-md)",
            fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: "16px", fontWeight: 500, whiteSpace: "nowrap" }}>{fmtT(nowS)}</span>
          <div style={{ position: "absolute", left: 0, right: 0, top: 22, height: 4, background: "var(--ground)", borderRadius: "var(--radius-pill)", boxShadow: "var(--inset-shadow)" }} />
          <div style={{ position: "absolute", left: 0, width: `${ph}%`, top: 23, height: 2, background: "var(--ink)", borderRadius: "var(--radius-pill)", marginLeft: 1 }} />
          <div title="Flooded area per frame" style={{ position: "absolute", left: 0, right: 0, top: 31, height: 4, borderRadius: "var(--radius-pill)", background: `linear-gradient(90deg, ${stops})` }} />
          <div title={`Rain falling, T+00:00 to ${fmtT(rainStopS)}`} style={{ position: "absolute", left: 0, width: `${pct(rainStopS)}%`, top: 29, height: 5, borderBottom: "1px dashed var(--ink-muted)", opacity: 0.6 }} />
          <span style={{ position: "absolute", left: `${ph}%`, top: 17, width: 14, height: 14, marginLeft: -7, borderRadius: "50%", background: "var(--ground)", border: "3px solid var(--danfo)",
            boxShadow: "0 0 0 4px color-mix(in srgb, var(--danfo) 22%, transparent), 0 2px 4px var(--elev-drop)" }} />
          <div style={{ position: "absolute", left: 0, right: 0, top: 38 }}>
            {events.filter((e) => e.kind !== "standing" && e.kind !== "peak").map((e) => (
              <span key={e.id} title={e.label} style={{ position: "absolute", left: `${pct(e.t)}%`, top: 0, transform: "translateX(-50%)", display: "flex" }}><Glyph kind={e.kind} muted={e.t > nowS} /></span>
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
            {Array.from({ length: hours + 1 }, (_, h) => (
              <span key={h} style={{ position: "absolute", left: `${(100 * h * 3600) / durS}%`, top: 10, transform: `translateX(${h === 0 ? "0" : h * 3600 >= durS ? "-100%" : "-50%"})`, fontSize: 11,
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
        <button type="button" data-tour="marks" disabled={!runId} title={runId ? `Add a note at ${fmtT(nowS)}` : "Run a simulation to add notes"}
          onClick={() => { clock.set({ playing: false }); setDraft({ t: nowS, text: "" }); }}
          style={{ marginLeft: "auto", height: 26, display: "flex", alignItems: "center", gap: 5, padding: "0 9px 0 7px", ...raisedButton, borderRadius: "var(--radius-md)", font: "inherit", fontSize: 12, fontWeight: 500,
            ...(runId ? {} : { opacity: 0.45, cursor: "not-allowed" }) }}>
          <Plus size={12} weight="bold" />Note</button></>} />
      {draft && (
        <div style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) auto", gap: 10, alignItems: "center", height: 36, padding: "0 12px 0 14px", borderBottom: "1px solid var(--hairline)" }}>
          <NotePencil size={14} weight="bold" color="var(--ink-muted)" />
          <input autoFocus value={draft.text} maxLength={NOTE_MAX} placeholder="Note, then Enter" aria-label={`Note at ${fmtT(draft.t)}`}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape") { e.preventDefault(); setDraft(null); } }}
            onBlur={() => setDraft(null)}
            style={{ minWidth: 0, height: 26, padding: "0 8px", background: "var(--ground)", color: "var(--ink)", border: "1px solid var(--control-edge)", borderRadius: "var(--radius-md)",
              boxShadow: "var(--inset-shadow)", font: "inherit", fontSize: 12 }} />
          <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{fmtT(draft.t)}</span>
        </div>
      )}
      <ol style={{ margin: "4px 0 0", padding: 0, listStyle: "none", minHeight: 0, overflowY: "auto" }}>
        {rows.map((r) => {
          if ("n" in r && r.n) {
            const n = r.n, fut = n.t_s > nowS;
            return (
              <li key={`note-${n.id}`} title={n.text} onClick={() => seek(n.t_s)}
                style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) auto 20px", gap: 10, alignItems: "center", height: 32, padding: "0 8px 0 14px", cursor: "pointer",
                  ...(fut ? { color: "var(--ink-muted)" } : {}) }}>
                <NotePencil size={14} weight="bold" color="var(--ink-muted)" />
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.text}</span>
                <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{fmtT(n.t_s)}</span>
                <button type="button" aria-label={`Remove note at ${fmtT(n.t_s)}`} title="Remove note" onClick={(ev) => { ev.stopPropagation(); if (runId) removeNote(runId, n.id); }}
                  style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, background: "transparent", border: 0, borderRadius: 3, color: "var(--ink-muted)", cursor: "pointer" }}>
                  <X size={12} weight="bold" />
                </button>
              </li>
            );
          }
          const e = (r as { e: Ev }).e;
          const fut = e.t > nowS, on = e.id === sel;
          return (
            <li key={e.id} title={e.place ?? undefined} onClick={() => { seek(e.t); if (e.point) setFocus({ lon: e.point[0], lat: e.point[1] }); }}
              style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) auto", gap: 10, alignItems: "center", height: 32, padding: "0 12px 0 14px", cursor: "pointer",
                ...(on ? { background: "var(--surface-raised)", boxShadow: "inset 3px 0 0 var(--danfo), inset 0 1px 0 var(--elev-hi), 0 1px 2px var(--elev-drop-soft)" } : {}), ...(fut ? { color: "var(--ink-muted)" } : {}) }}>
              <Glyph kind={e.kind} muted={fut} /><span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...(on ? { fontWeight: 600 } : {}) }}>{e.label}</span>
              <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{fmtT(e.t)}</span>
            </li>
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
        <ChartFigure last title="Rain intensity" unit="mm/h" now={`${Math.max(...series).toFixed(0)} peak`} series={series} color="var(--depth-3)" gid="rn" playI={-1} ymaxMin={Math.max(...series) * 1.2} tTotal={storm.duration_h * 3600}
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
export type DockLayout = "row" | "two" | "extras" | "stack";
const dockShell = (layout: DockLayout): CSSProperties => (layout === "row"
  ? { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 248px", background: "var(--surface)", borderTop: "1px solid var(--hairline)", minHeight: 0 }
  : layout === "two" ? { display: "flex", flexDirection: "column", background: "var(--surface)", borderTop: "1px solid var(--hairline)", minHeight: 0 }
  : { display: "flex", flexDirection: "column", background: "var(--surface)", minHeight: 0, border: layout === "extras" ? "1px solid var(--hairline)" : undefined,
    borderRadius: layout === "extras" ? 6 : undefined, overflow: layout === "extras" ? "hidden" : undefined });

export function Dock({ storm, run, series, ghost, third, side, note, layout = "row" }: { storm?: RainStorm; run?: RunManifest; /** Depth in metres at the selected map point, one value per frame. */ series?: number[];
  layout?: DockLayout;
  /** Compare mode: run A, drawn under `run` (B) in the charts. */ ghost?: RunManifest;
  /** Replace the third chart and the Key events column; `note` replaces the timeline's frame summary. */
  third?: ReactNode; side?: ReactNode; note?: string }) {
  const { t_s, playing, speed } = useClock();
  const ts = run?.timeseries ?? null;
  // Drainage runs: the third chart can show the drain network, and the side panel where the water went (shown first).
  const [thirdPick, setThirdPick] = useState<"drains" | "depth">("drains");
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
  const common = { playI: pi, tTotal: durS };
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
  const charts = [
          <ChartFigure key="fa" last={narrow} title="Flooded area" unit="km²" now={ts.flooded_area_km2[pi].toFixed(2)} ab={gfa && abNow(gfa[pi], ts.flooded_area_km2[pi], 2)} ghost={gfa} series={ts.flooded_area_km2} color="var(--depth-3)" gid="fa" events={chartEvents} {...common}
            aria={`Flooded area over time; ${ts.flooded_area_km2[pi].toFixed(2)} square kilometres at the playhead, ${fmtT(t_s)}`} />,
          <ChartFigure key="rk" last={layout === "two" ? true : narrow} title="Roads impassable" unit="km" now={ts.road_km_impassable[pi].toFixed(1)} ab={grk && abNow(grk[pi], ts.road_km_impassable[pi], 1)} ghost={grk} series={ts.road_km_impassable} color="var(--hazard)" gid="rk" events={chartEvents} baseline={pondKm != null ? [pondKm, `${pondKm.toFixed(1)} km closed by the planned pond`] : undefined} {...common}
            aria={`Impassable road length over time; ${ts.road_km_impassable[pi].toFixed(1)} kilometres at the playhead`} />,
          third ?? (ds && thirdPick === "drains"
            ? <ChartFigure last title="Drain network running full" unit="%" now={`${Math.round(ds[Math.min(pi, ds.length - 1)] ?? 0)} at ${fmtT(ts.t_s[pi])}`} series={ds} menu={menu}
                color="var(--depth-3)" gid="dn" ymaxMin={100} threshold={[FULL_PCT, `Full ${FULL_PCT} %`]} {...common}
                aria={`Share of the drain network running full over time; ${Math.round(ds[Math.min(pi, ds.length - 1)] ?? 0)} % at the playhead`} />
            : <ChartFigure last title="Depth at selected point" unit="m" now={dp ? (dp[Math.min(pi, dp.length - 1)] ?? 0).toFixed(2) : "–"} series={dp} empty="Pick a point on the map" menu={menu}
                color="var(--depth-3)" gid="dp" ymaxMin={0.5} threshold={[0.3, "Impassable 0.30 m"]} {...common} aria="Depth at the selected map point over time" />),
  ];
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
        {profile ? <ProfileDock /> : <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", borderTop: "1px solid var(--hairline)", minHeight: 0 }}>
          {charts}
        </div>}
      </div>
      {sidePanel}
    </div>
  );
}
