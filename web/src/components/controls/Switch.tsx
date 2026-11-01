// Switch (board 11, docs/design/rev5-ref/Controls.dc.html): a role=switch button; Space and Enter toggle.
import { useState } from "react";
import type { ReactNode } from "react";

// Native button activation handles Space and Enter once. No motion is needed for the knob.
export function Switch({ on, label, onChange, disabled = false, fill = false }: { on: boolean; label: ReactNode; onChange: (v: boolean) => void; disabled?: boolean;
  /** Take the row's free width, so the whole label is the target and a long one truncates. */ fill?: boolean }) {
  const [ring, setRing] = useState(false);
  return <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
    onFocus={(e) => setRing(e.currentTarget.matches(":focus-visible"))} onBlur={() => setRing(false)}
    style={{ display: "inline-flex", alignItems: "center", gap: 10, ...(fill ? { flex: 1, minWidth: 0, height: "100%" } : {}), padding: 0, border: 0, background: "transparent", color: "inherit", font: "inherit", textAlign: "left", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1, outline: "none" }}>
    <span aria-hidden="true" style={{ position: "relative", display: "inline-block", width: 30, height: 18, flex: "none", borderRadius: "var(--radius-pill)", background: on ? "var(--danfo)" : "var(--ground)", boxShadow: on ? undefined : "var(--inset-shadow)", outline: ring ? "2px solid var(--focus-ring)" : "none", outlineOffset: 2 }}>
      <span style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)" }} />
    </span>{label}
  </button>;
}
