// Dock (rev 5 dock()): timeline, three charts, key events. Everything reads the one clock.
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { CaretDown, DotsThreeVertical, Plus } from "@phosphor-icons/react";
import type { RunManifest } from "../lib/api";
import { clock, useClock } from "../lib/clock";
import { fmtT } from "./ds";
import { Band, EVENT_ICON, EventKind, FIG, Glyph, raisedButton } from "./rev5";

type Ev = { kind: EventKind; label: string; i: number; t: number };
type TS = NonNullable<RunManifest["timeseries"]>;
const SPEEDS = [300, 600, 1200];

/** Frame index closest to a time. */
const nearest = (ts: number[], t: number) => {
  let best = 0;
  ts.forEach((v, i) => { if (Math.abs(v - t) < Math.abs(ts[best] - t)) best = i; });
  return best;
};

function deriveEvents(ts: TS, rainStopS: number): Ev[] {
  const out: Ev[] = [];
  const add = (kind: EventKind, label: string, i: number) => out.push({ kind, label, i, t: ts.t_s[i] });
  const cut = ts.edges_cut.findIndex((c) => c > 0);
  if (cut >= 0) add("cut", "First road impassable", cut);
  let surge = -1, jump = 0;
  ts.edges_cut.forEach((c, i) => { if (i && c - ts.edges_cut[i - 1] > jump) { jump = c - ts.edges_cut[i - 1]; surge = i; } });
  if (surge >= 0) add("surge", "Route cuts surge", surge);
  if (ts.flooded_area_km2.length) add("peak", "Peak flooded area", ts.flooded_area_km2.indexOf(Math.max(...ts.flooded_area_km2)));
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

function Chart({ series, color, playI, tTotal, width, aria, gid, threshold, events = [], ymaxMin = 0 }: {
  series: number[]; color: string; playI: number; tTotal: number; width: number; aria: string; gid: string;
  threshold?: [number, string]; events?: Ev[]; ymaxMin?: number;
}) {
  const W = width, H = 104, L = 32, R = 6, T = 8, B = 20;
  const pw = W - L - R, ph = H - T - B, base = T + ph;
  const n = series.length;
  const ymax = niceMax(Math.max(ymaxMin, ...series));
  const yticks = [0, ymax / 2, ymax];
  const X = (i: number) => L + (pw * i) / Math.max(1, n - 1);
  const Y = (v: number) => T + ph * (1 - v / ymax);
  const pts = series.map((v, i) => [X(i), Y(v)] as const);
  const pi = Math.min(Math.max(playI, 0), n - 1);
  const path = (ps: (readonly [number, number])[]) => "M" + ps.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L");
  const past = pts.slice(0, pi + 1), fut = pts.slice(pi);
  const hours = Math.max(1, Math.round(tTotal / 3600));
  const xl = [0, 1, 2, 3].map((k) => Math.round((hours * k) / 3)).filter((h, k, a) => a.indexOf(h) === k);
  const style = { display: "block", overflow: "visible", fontFamily: "var(--font-sans)", fontSize: 10.5, ...FIG } as const;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria} style={style}>
      <defs>
        <linearGradient id={`${gid}p`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.42" /><stop offset="1" stopColor={color} stopOpacity="0.06" /></linearGradient>
        <linearGradient id={`${gid}f`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.14" /><stop offset="1" stopColor={color} stopOpacity="0.02" /></linearGradient>
      </defs>
      {Array.from({ length: hours + 1 }, (_, h) => { const x = L + (pw * h) / hours; return <line key={h} x1={x} y1={T} x2={x} y2={base} stroke="var(--hairline)" strokeWidth="1" opacity="0.55" />; })}
      {yticks.map((v) => (
        <g key={v}>
          {v > 0 && <line x1={L} y1={Y(v)} x2={W - R} y2={Y(v)} stroke="var(--hairline)" strokeWidth="1" />}
          <text x={L - 6} y={Y(v) + 3.5} textAnchor="end" fill="var(--ink-muted)">{tickLabel(v)}</text>
        </g>
      ))}
      {n > 1 && <>
        <path d={`${path(fut)} L${fut[fut.length - 1][0].toFixed(1)} ${base} L${fut[0][0].toFixed(1)} ${base} Z`} fill={`url(#${gid}f)`} />
        <path d={`${path(past)} L${past[past.length - 1][0].toFixed(1)} ${base} L${past[0][0].toFixed(1)} ${base} Z`} fill={`url(#${gid}p)`} />
        <path d={path(fut)} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6" />
        <path d={path(past)} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" />
      </>}
      {threshold && (
        <g>
          <line x1={L} y1={Y(threshold[0])} x2={W - R} y2={Y(threshold[0])} stroke="var(--hazard)" strokeWidth="1" strokeDasharray="4 3" />
          <text x={L + 4} y={Y(threshold[0]) - 4} textAnchor="start" fill="var(--hazard)" fontSize="10">{threshold[1]}</text>
        </g>
      )}
      <line x1={L} y1={base} x2={W - R} y2={base} stroke="var(--control-edge)" strokeWidth="1" />
      {xl.map((h, k) => (
        <text key={h} x={L + (pw * h) / hours} y={H - 5} textAnchor={k === 0 ? "start" : h === hours ? "end" : "middle"} fill="var(--ink-muted)">T+{String(h).padStart(2, "0")}:00</text>
      ))}
      {events.map((e) => pts[e.i] && (
        <g key={e.kind}>
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

function ChartFigure({ title, unit, now, last, series, empty, ...rest }: {
  title: string; unit: string; now: string; last?: boolean; series?: number[]; empty?: string;
} & Omit<React.ComponentProps<typeof Chart>, "series" | "width">) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
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
        <span style={{ marginLeft: "auto", fontWeight: 600, ...FIG }}>{now}</span>
        <span style={{ display: "flex", alignSelf: "center", color: "var(--ink-muted)" }}><DotsThreeVertical size={14} weight="bold" /></span>
      </figcaption>
      <div ref={ref} style={{ height: 104, position: "relative", minWidth: 0 }}>
        {series && series.length > 1 && w > 60 ? <Chart series={series} width={w} {...rest} />
          : <p style={{ margin: 0, height: 104, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", fontSize: 12 }}>{empty ?? "No data yet"}</p>}
      </div>
    </figure>
  );
}

const sq: React.CSSProperties = { height: 30, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, borderRadius: "var(--radius-md)" };

function Timeline({ ts, events, durS, rainStopS, nowS, playing, speed }: { ts: TS; events: Ev[]; durS: number; rainStopS: number; nowS: number; playing: boolean; speed: number }) {
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
      <Band title="Timeline" right={<span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 12 }}><span style={{ fontFamily: "var(--font-mono)" }}>T+00:00 – {fmtT(durS)}</span> · {frames} frames, {stepMin} min</span>} />
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
              <span key={e.kind} title={e.label} style={{ position: "absolute", left: `${pct(e.t)}%`, top: 0, transform: "translateX(-50%)", display: "flex" }}><Glyph kind={e.kind} muted={e.t > nowS} /></span>
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

function KeyEvents({ events, nowS }: { events: Ev[]; nowS: number }) {
  const sel = [...events].reverse().find((e) => e.t <= nowS)?.kind;
  return (
    <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid var(--hairline)", minHeight: 0, background: "var(--surface)" }}>
      <Band title="Key events" right={
        <button type="button" style={{ marginLeft: "auto", height: 26, display: "flex", alignItems: "center", gap: 5, padding: "0 9px 0 7px", ...raisedButton, borderRadius: "var(--radius-md)", font: "inherit", fontSize: 12, fontWeight: 500 }}>
          <Plus size={12} weight="bold" />Note</button>} />
      <ol style={{ margin: "4px 0 0", padding: 0, listStyle: "none" }}>
        {events.map((e) => {
          const fut = e.t > nowS, on = e.kind === sel;
          return (
            <li key={e.kind} onClick={() => clock.set({ t_s: e.t, playing: false })}
              style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) auto", gap: 10, alignItems: "center", height: 32, padding: "0 12px 0 14px", cursor: "pointer",
                ...(on ? { background: "var(--surface-raised)", boxShadow: "inset 3px 0 0 var(--danfo), inset 0 1px 0 var(--elev-hi), 0 1px 2px var(--elev-drop-soft)" } : {}), ...(fut ? { color: "var(--ink-muted)" } : {}) }}>
              <Glyph kind={e.kind} muted={fut} /><span style={on ? { fontWeight: 600 } : undefined}>{e.label}</span>
              <span style={{ fontSize: 12, color: "var(--ink-muted)", ...FIG }}>{fmtT(e.t)}</span>
            </li>
          );
        })}
      </ol>
      <p style={{ margin: "auto 14px 10px", color: "var(--ink-muted)", fontSize: 11, lineHeight: "15px" }}>Greyed events are after the playhead.</p>
    </div>
  );
}

export function Dock({ run, series }: { run?: RunManifest; /** Depth in metres at the selected map point, one value per frame. */ series?: number[] }) {
  const { t_s, playing, speed } = useClock();
  const ts = run?.timeseries ?? null;
  const rainStopS = (run?.scenario.storm.duration_h ?? 3) * 3600;
  const events = useMemo(() => (ts && ts.t_s.length > 1 ? deriveEvents(ts, rainStopS) : []), [ts, rainStopS]);
  const shell = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 248px", background: "var(--surface)", borderTop: "1px solid var(--hairline)", minHeight: 0 } as const;
  if (!ts || ts.t_s.length < 2) {
    return <div style={shell}><div style={{ display: "flex", flexDirection: "column" }}><Band title="Timeline" /><p style={{ margin: 0, padding: 18, color: "var(--ink-muted)" }}>Run a simulation to see the timeline and charts.</p></div>
      <KeyEvents events={[]} nowS={0} /></div>;
  }
  const durS = ts.t_s[ts.t_s.length - 1];
  const pi = nearest(ts.t_s, t_s);
  const chartEvents = events.filter((e) => e.kind === "cut" || e.kind === "surge");
  const common = { playI: pi, tTotal: durS };
  const dp = series && series.length > 1 ? series : undefined;
  return (
    <div style={shell}>
      <div style={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", minWidth: 0 }}>
        <Timeline ts={ts} events={events} durS={durS} rainStopS={rainStopS} nowS={t_s} playing={playing} speed={speed} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", borderTop: "1px solid var(--hairline)", minHeight: 0 }}>
          <ChartFigure title="Flooded area" unit="km²" now={ts.flooded_area_km2[pi].toFixed(2)} series={ts.flooded_area_km2} color="var(--depth-3)" gid="fa" events={chartEvents} {...common}
            aria={`Flooded area over time; ${ts.flooded_area_km2[pi].toFixed(2)} square kilometres at the playhead, ${fmtT(t_s)}`} />
          <ChartFigure title="Roads impassable" unit="km" now={ts.road_km_impassable[pi].toFixed(1)} series={ts.road_km_impassable} color="var(--hazard)" gid="rk" events={chartEvents} {...common}
            aria={`Impassable road length over time; ${ts.road_km_impassable[pi].toFixed(1)} kilometres at the playhead`} />
          <ChartFigure last title="Depth at selected point" unit="m" now={dp ? (dp[Math.min(pi, dp.length - 1)] ?? 0).toFixed(2) : "–"} series={dp} empty="Pick a point on the map"
            color="var(--depth-3)" gid="dp" ymaxMin={0.5} threshold={[0.3, "Impassable 0.30 m"]} {...common} aria="Depth at the selected map point over time" />
        </div>
      </div>
      <KeyEvents events={events} nowS={t_s} />
    </div>
  );
}
