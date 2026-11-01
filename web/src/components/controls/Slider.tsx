// Slider (board 11, docs/design/rev5-ref/Controls.dc.html): role=slider on a drawn track, no native range input.
// Arrows step, Shift+arrows and PageUp/PageDown step ×10, Home/End jump to the ends; the value is shown as text.
import { useRef, useState } from "react";

export function roundValue(v: number, min: number, max: number, step: number) {
  const [mantissa, exponent] = step.toExponential().split("e");
  const decimals = Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent));
  return Math.max(min, Math.min(max, Number((min + Math.round((v - min) / step) * step).toFixed(decimals))));
}
export function nextValue(key: string, shift: boolean, value: number, min: number, max: number, step: number) {
  if (key === "Home") return min;
  if (key === "End") return max;
  const direction = ["ArrowUp", "ArrowRight", "PageUp"].includes(key) ? 1 : ["ArrowDown", "ArrowLeft", "PageDown"].includes(key) ? -1 : 0;
  return direction ? roundValue(value + direction * step * (shift || key.startsWith("Page") ? 10 : 1), min, max, step) : null;
}

type Props = { label: string; value: number; min: number; max: number; step?: number; text?: string; lo?: string; hi?: string;
  /** The 52 px layer-opacity slider. */ compact?: boolean;
  /** Only the track, filling its row (the label and value are shown beside it). */ bare?: boolean;
  disabled?: boolean; onChange: (v: number) => void };

// Pointer capture keeps touch and mouse drags updating even outside the track.
export function Slider({ label, value, min, max, step = 1, text = String(value), lo = String(min), hi = String(max), compact = false, bare = false, disabled = false, onChange }: Props) {
  const [ring, setRing] = useState(false);
  const drag = useRef<number | null>(null);
  const pct = Math.max(0, Math.min(100, (value - min) / (max - min) * 100));
  const set = (el: HTMLSpanElement, x: number) => { const r = el.getBoundingClientRect(); if (r.width) onChange(roundValue(min + (x - r.left) / r.width * (max - min), min, max, step)); };
  const focusRing = ring ? { outline: "2px solid var(--focus-ring)", outlineOffset: 2 } : { outline: "none" };
  const labelled = !compact && !bare;
  return <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: compact ? "none" : 1, minWidth: 0, opacity: disabled ? 0.45 : 1 }}>
    {labelled && <span style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ color: "var(--ink-muted)" }}>{label}</span><span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{text}</span></span>}
    <span role="slider" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={text} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
      onFocus={(e) => setRing(e.currentTarget.matches(":focus-visible"))} onBlur={() => setRing(false)}
      onKeyDown={(e) => { if (disabled) return; const n = nextValue(e.key, e.shiftKey, value, min, max, step); if (n !== null) { e.preventDefault(); e.stopPropagation(); onChange(n); } }}
      onPointerDown={(e) => { if (disabled || e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = e.pointerId; set(e.currentTarget, e.clientX); }}
      onPointerMove={(e) => { if (!disabled && drag.current === e.pointerId) set(e.currentTarget, e.clientX); }}
      onPointerUp={(e) => { if (drag.current === e.pointerId) { if (!disabled) set(e.currentTarget, e.clientX); drag.current = null; e.currentTarget.releasePointerCapture(e.pointerId); } }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      style={{ position: "relative", display: "block", width: compact ? 52 : "100%", height: compact ? 12 : 22, flex: "none", touchAction: "none", cursor: disabled ? "default" : "pointer", ...(compact ? focusRing : { outline: "none" }) }}>
      {/* On touch the compact track's hit area grows to 40 px (.dr-hit in app.css); the look stays 12 px. */}
      {compact && <span className="dr-hit" aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} />}
      <span style={{ position: "absolute", left: 0, right: 0, top: compact ? 5 : "calc(50% - 2px)", height: compact ? 2 : 4, background: compact ? "var(--hairline)" : "var(--ground)", borderRadius: "var(--radius-pill)", boxShadow: compact ? "inset 0 1px 1px var(--elev-drop)" : "var(--inset-shadow)" }} />
      <span style={{ position: "absolute", left: 0, width: `${pct}%`, top: compact ? 5 : "calc(50% - 2px)", height: compact ? 2 : 4, background: compact ? "var(--ink-muted)" : "var(--danfo)", borderRadius: "var(--radius-pill)" }} />
      <span style={{ position: "absolute", left: `${pct}%`, top: compact ? 1 : "calc(50% - 8px)", width: compact ? 10 : 16, height: compact ? 10 : 16, marginLeft: compact ? -5 : -8, borderRadius: "50%", background: compact ? "var(--ink)" : "var(--raised-bg)", border: compact ? undefined : "1px solid var(--control-edge)", boxShadow: compact ? "0 1px 3px var(--elev-drop), 0 0 0 1px color-mix(in srgb, var(--ground) 40%, transparent)" : "var(--raised-shadow)", ...(compact ? {} : focusRing) }} />
    </span>
    {labelled && <span style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-muted)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}><span>{lo}</span><span>{hi}</span></span>}
  </span>;
}
