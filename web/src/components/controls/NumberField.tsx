// NumberField (docs/design/rev5-ref/Controls.dc.html): inset value and unit with −/+ steppers.
import { useEffect, useId, useState } from "react";

const rounded = (value: number) => Number(value.toFixed(12));
export function parseInRange(text: string, min?: number, max?: number): { value: number | null; error: boolean } {
  const value = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) ? Number(text) : NaN;
  const error = !Number.isFinite(value) || (min !== undefined && value < min) || (max !== undefined && value > max);
  return { value: error ? null : rounded(value), error };
}
export function stepValue(key: string, shift: boolean, value: number, min?: number, max?: number, step = 1): number {
  if (key === "Home") return min ?? value;
  if (key === "End") return max ?? value;
  const direction = key === "ArrowUp" || key === "PageUp" ? 1 : key === "ArrowDown" || key === "PageDown" ? -1 : 0;
  const next = rounded(value + direction * step * (shift || key.startsWith("Page") ? 10 : 1));
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));
}
export function NumberField({ value, unit, min, max, step = 1, label, onChange }: {
  value: number; unit: string; min?: number; max?: number; step?: number; label: string; onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState(false);
  const id = useId();
  useEffect(() => { setText(String(value)); setError(false); }, [value]);
  const update = (next: number) => { setText(String(next)); setError(false); if (next !== value) onChange(next); };
  const commit = () => { const result = parseInRange(text, min, max); setError(result.error); if (result.value !== null) update(result.value); };
  const range = min !== undefined && max !== undefined ? `Between ${min} and ${max}` : min !== undefined ? `At least ${min}` : max !== undefined ? `At most ${max}` : "Enter a number";
  return <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
    <div className="dr-number-field" style={{ display: "flex", alignItems: "center", gap: 2, height: 32, padding: "0 4px 0 10px", background: "var(--ground)", border: `1px solid ${error ? "var(--hazard)" : "var(--control-edge)"}`, borderRadius: "var(--radius-md)", boxShadow: "inset 0 1px 2px var(--elev-drop-soft)" }}>
      <input inputMode="decimal" role="spinbutton" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value} ${unit}`} aria-invalid={error} aria-describedby={error ? id : undefined} value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) { e.preventDefault(); update(stepValue(e.key, e.shiftKey, value, min, max, step)); }
        }} style={{ width: `${Math.max(text.length, 1)}ch`, maxWidth: "100%", minWidth: 0, padding: 0, border: 0, outline: "none", background: "transparent", color: "var(--ink)", font: "inherit", fontWeight: 600, fontVariantNumeric: "tabular-nums" }} />
      <span style={{ marginLeft: 6, color: "var(--ink-muted)" }}>{unit}</span>
      <span style={{ marginLeft: "auto", display: "flex" }}>{(["ArrowDown", "ArrowUp"] as const).map((key, i) => <button key={key} type="button" aria-label={`${i ? "Increase" : "Decrease"} ${label}`} disabled={i ? max !== undefined && value >= max : min !== undefined && value <= min} onMouseDown={(e) => e.preventDefault()} onClick={() => update(stepValue(key, false, value, min, max, step))} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, border: 0, padding: 0, borderRadius: 3, color: "var(--ink-muted)", background: "transparent" }}>{i ? "+" : "−"}</button>)}</span>
    </div>
    {/* Always mounted, so a screen reader announces the range when it appears on blur or Enter. */}
    <span id={id} aria-live="polite" style={{ marginTop: error ? 4 : 0, color: "var(--hazard)", fontSize: 12 }}>{error ? `${range}${unit ? ` ${unit}` : ""}` : ""}</span>
  </div>;
}
