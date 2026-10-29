// In-panel failure notice (design pass: docs/design/error-feedback.md). Not a toast: it sits under the
// panel's own results, so no shadow and no motion. The message comes from the server verbatim.
import type { ReactNode } from "react";

export function Notice({ message, detail, children }: { message: string; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div role="alert" style={{
      display: "flex", flexDirection: "column", gap: "var(--space-2)", padding: "var(--space-3)",
      background: "var(--surface-raised)", borderLeft: "var(--stroke-control) solid var(--hazard)",
      borderRadius: "var(--radius-md)", color: "var(--ink)",
    }}>
      <div className="body">
        <span style={{ color: "var(--hazard)" }}>⚠</span> <span className="label">FAILED</span> {message}
      </div>
      {detail && <div className="caption" style={{ color: "var(--ink-muted)" }}>{detail}</div>}
      {children && <div style={{ display: "flex", gap: "var(--space-2)" }}>{children}</div>}
    </div>
  );
}
