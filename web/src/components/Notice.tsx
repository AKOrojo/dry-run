// In-panel failure notice (design pass: docs/design/error-feedback.md; rev5 restyle). Not a toast: it sits under the
// panel's own results, so no shadow and no motion. The message comes from the server verbatim.
// Actions are passed as children. With `wait` it shows the countdown ring (radius 15, stroke 3) over `total` seconds.
import type { ReactNode } from "react";
import { FIG } from "./rev5";

const R = 15;
const C = 2 * Math.PI * R;

function Ring({ wait, total }: { wait: number; total: number }) {
  const frac = total > 0 ? Math.min(1, wait / total) : 0;
  return (
    <span style={{ position: "relative", width: 40, height: 40, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
        <circle cx="20" cy="20" r={R} fill="none" stroke="var(--hairline)" strokeWidth="3" />
        <circle cx="20" cy="20" r={R} fill="none" stroke="var(--hazard)" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 20 20)" />
      </svg>
      <span style={{ ...FIG, fontSize: 13, fontWeight: 600 }}>{wait}</span>
    </span>
  );
}

export function Notice({ message, detail, note, wait = 0, total = 0, children }:
  { message: string; detail?: ReactNode; note?: ReactNode; wait?: number; total?: number; children?: ReactNode }) {
  return (
    <div role="alert" style={{ display: "flex", gap: 12, padding: "12px 14px", borderLeft: "3px solid var(--hazard)",
      background: "color-mix(in srgb, var(--hazard) 10%, var(--surface))" }}>
      {wait > 0 && <Ring wait={wait} total={total} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, lineHeight: "20px", fontWeight: 600 }}>{message}</div>
        {detail && <div style={{ fontSize: 13, lineHeight: "18px", color: "var(--ink-muted)" }}>{detail}</div>}
        {note && <div style={{ fontSize: 13, lineHeight: "18px", color: "var(--ink-muted)" }}>{note}</div>}
        {children && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>{children}</div>}
      </div>
    </div>
  );
}
