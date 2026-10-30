// Typed port of the Dry Run design-system components (docs/DryRun-design-system/components/bundle.js).
// Same markup and ft-* classes; styles come from styles/bundle.css. TimelineBar adds scrubbing.
import { useRef } from "react";
import type { ButtonHTMLAttributes, KeyboardEvent, MouseEventHandler, PointerEvent, ReactNode } from "react";

const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");

/** Seconds since storm start as T+hh:mm. */
export function fmtT(s: number) {
  s = Math.max(0, Math.round(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
  return `T+${hh < 10 ? "0" : ""}${hh}:${mm < 10 ? "0" : ""}${mm}`;
}
function num(v: number | null | undefined, digits = 2) {
  if (v === null || v === undefined || isNaN(v)) return "n/a";
  const s = Math.abs(v).toLocaleString("en-GB", { maximumFractionDigits: digits });
  return (v < 0 ? "−" : "") + s;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = danfo fill, one per panel; quiet = bordered secondary; ghost = toolbar. Default quiet. */
  variant?: "primary" | "quiet" | "ghost";
  children: ReactNode;
}
export function Button({ variant = "quiet", className, children, ...rest }: ButtonProps) {
  return <button type="button" {...rest} className={cx("ft-btn", `ft-btn-${variant}`, className)}>{children}</button>;
}

const BADGE = {
  simulated: "Simulated", observed: "Observed", ai: "AI illustration",
  placeholder: "Placeholder physics", synthetic: "Synthetic terrain",
};
export interface ProvenanceBadgeProps {
  kind?: keyof typeof BADGE;
  title?: string;
  className?: string;
  children?: ReactNode;
}
export function ProvenanceBadge({ kind = "simulated", title, className, children }: ProvenanceBadgeProps) {
  return <span className={cx("ft-badge", `ft-badge-${kind}`, className)} title={title}>{children || BADGE[kind]}</span>;
}

export interface ClaimItemProps {
  text: string;
  value: number | null;
  unit?: string;
  verified: boolean;
  modelValue?: number | null;
  sourceRunId?: string;
}
export function ClaimItem({ text, value, unit, verified, modelValue, sourceRunId }: ClaimItemProps) {
  const showAudit = !verified && modelValue !== null && modelValue !== undefined;
  return (
    <div className={cx("ft-claim", verified ? "ft-claim-ok" : "ft-claim-bad")}>
      <span className="ft-claim-mark">{verified ? "✓ verified" : "⚠ unverified"}</span>
      <span className="ft-claim-text">{text}</span>
      <span className="ft-claim-value">{num(value) + (unit ? " " + unit : "")}</span>
      {showAudit && <span className="ft-claim-audit">{`Model said ${num(modelValue)}; value shown is from run ${sourceRunId || ""}`}</span>}
    </div>
  );
}

export interface StatDeltaProps {
  label: string; base: number; alt: number; unit?: string; better?: "lower" | "higher"; digits?: number;
}
export function StatDelta({ label, base, alt, unit, better, digits }: StatDeltaProps) {
  const d = alt - base;
  const lowerIsBetter = better !== "higher";
  const state = d === 0 || isNaN(d) ? "" : (d < 0) === lowerIsBetter ? "ft-stat-better" : "ft-stat-worse";
  const word = state === "ft-stat-better" ? "better" : state === "ft-stat-worse" ? "worse" : "no change";
  return (
    <div className={cx("ft-stat", state)}>
      <span className="ft-stat-label">{label}</span>
      <span className="ft-stat-delta">{(d > 0 ? "+" : "") + num(d, digits) + (unit ? " " + unit : "")}</span>
      <span className="ft-stat-span">{`${num(base, digits)} → ${num(alt, digits)} · ${word}`}</span>
    </div>
  );
}

const EDGES = [0.05, 0.15, 0.3, 0.5, 1, 2];
export interface DepthLegendProps {
  edges?: number[]; title?: string;
  /** stats.passability_threshold_m when present; otherwise the note falls back to 0.30 m. Both are assumptions. */
  passabilityM?: number;
  note?: string | false;
}
export function DepthLegend({ edges = EDGES, title, passabilityM, note }: DepthLegendProps) {
  const road = passabilityM !== undefined ? num(passabilityM) : "0.30";
  return (
    <div className="ft-legend">
      <span className="ft-stat-label">{title || "Water depth (m)"}</span>
      <div className="ft-legend-bins">{edges.map((_, i) => <span key={i} className={`ft-legend-bin ft-d${i + 1}`} />)}</div>
      <div className="ft-legend-ticks">{edges.map((e, i) => <span key={i}>{String(e)}</span>)}</div>
      {note !== false && <span className="ft-legend-note">
        {note || `Assumptions: flooded ≥ 0.15 m, road impassable ≥ ${road} m. Simulated, not a forecast.`}
      </span>}
    </div>
  );
}

export interface TimelineBarProps {
  tS: number; maxS: number; playing: boolean;
  onToggle?: MouseEventHandler<HTMLButtonElement>;
  markers?: { tS: number; label?: string }[];
  /** Called with the new time when the track is dragged or stepped by keyboard. */
  onSeek?: (tS: number) => void;
  /** Keyboard step in seconds (left/right). Default 1/60 of the range. */
  step?: number;
}
export function TimelineBar({ tS, maxS, playing, onToggle, markers, onSeek, step }: TimelineBarProps) {
  const max = maxS || 1, t = Math.min(Math.max(tS || 0, 0), max);
  const pct = (s: number) => `${(100 * s) / max}%`;
  const track = useRef<HTMLDivElement>(null);
  const seekAt = (e: PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    if (r.width > 0) onSeek?.(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * max);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); seekAt(e); };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seekAt(e); };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const s = step ?? max / 60;
    const next = e.key === "ArrowLeft" ? t - s : e.key === "ArrowRight" ? t + s : e.key === "Home" ? 0 : e.key === "End" ? max : null;
    if (next === null) return;
    e.preventDefault();
    onSeek?.(Math.min(Math.max(next, 0), max));
  };
  return (
    <div className="ft-timeline">
      <Button variant="ghost" onClick={onToggle} aria-label={playing ? "Pause" : "Play"}>{playing ? "Pause" : "Play"}</Button>
      <div ref={track} className="ft-track" role="slider" aria-label="Time since storm start" aria-valuemin={0} aria-valuemax={max}
        aria-valuenow={t} aria-valuetext={fmtT(t)} tabIndex={0}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onKeyDown={onKeyDown}>
        <div className="ft-track-fill" style={{ width: pct(t) }} />
        {(markers || []).map((m, i) => (
          <div key={i} className="ft-marker" style={{ left: pct(m.tS) }}>
            {m.label && <span className="ft-marker-label">{m.label}</span>}
          </div>
        ))}
        <div className="ft-playhead" style={{ left: pct(t) }} />
      </div>
      <span className="ft-clock">{fmtT(t)}</span>
    </div>
  );
}

const TYPES = { drain_upgrade: "Drains", green: "Green", pond: "Pond", tide: "Tide", road_closure: "Closure" };
export interface InterventionChipProps {
  type: keyof typeof TYPES; place?: string; detail?: string; cellsChanged?: number;
}
export function InterventionChip({ type, place, detail, cellsChanged }: InterventionChipProps) {
  const none = cellsChanged === 0;
  return (
    <span className={cx("ft-chip", none && "ft-chip-none")}>
      <span className="ft-chip-swatch" aria-hidden />
      <span className="ft-chip-type">{TYPES[type] || type}</span>
      <span>{place || detail || "Whole area"}</span>
      {none && <span className="ft-chip-warn">⚠ no effect</span>}
    </span>
  );
}
