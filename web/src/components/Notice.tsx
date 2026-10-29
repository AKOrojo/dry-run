// In-panel failure notice (design pass: docs/design/error-feedback.md). Not a toast: it sits under the
// panel's own results, so no shadow and no motion. The message comes from the server verbatim.
// Actions are passed as children: use ds Button quiet.
import type { ReactNode } from "react";

export function Notice({ message, detail, children }: { message: string; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div role="alert" className="dr-notice">
      <div className="body">
        <span className="dr-notice-glyph">⚠</span> <span className="label">Failed</span> {message}
      </div>
      {detail && <div className="caption dr-muted">{detail}</div>}
      {children && <div className="dr-row">{children}</div>}
    </div>
  );
}
