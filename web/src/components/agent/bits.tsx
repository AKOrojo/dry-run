// Small shared pieces for the Agent panel (rev5 Agent.dc.html).
import type { CSSProperties, ReactNode } from "react";
import { raisedButton, mono } from "../rev5";
import { Button } from "../controls/Button";

const ghostButton: CSSProperties = { background: "transparent", color: "var(--ink-muted)", border: "1px solid transparent" };
const btnBase: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, height: 32, padding: "0 12px",
  borderRadius: "var(--radius-md)", font: "inherit", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" };

export function Btn({ kind, icon, children, ...rest }:
  { kind: "primary" | "raised" | "ghost"; icon?: ReactNode; children: ReactNode; onClick?: () => void; disabled?: boolean; "aria-describedby"?: string }) {
  // The primary is a flat danfo fill with no shadow; the ghost is the text look with a transparent border.
  const look: CSSProperties = kind === "primary"
    ? { background: "var(--danfo)", color: "var(--on-danfo)", border: "1px solid var(--danfo-edge)", boxShadow: "none", fontWeight: 600 }
    : kind === "raised" ? raisedButton : ghostButton;
  const variant = kind === "primary" ? "danfo" : kind === "raised" ? "raised" : "text";
  return <Button variant={variant} {...rest} style={{ ...btnBase, ...look }}>{icon}{children}</Button>;
}

export function Badge({ children }: { children: ReactNode }) {
  return <span className="badge" style={{ padding: "0 6px", border: "1px solid var(--control-edge)", borderRadius: 2, color: "var(--ink-muted)",
    textTransform: "uppercase", fontFamily: mono, flex: "none" }}>{children}</span>;
}

export function Dot({ color }: { color: string }) {
  return <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: color, flex: "none" }} />;
}

export const Pad = ({ children, gap = 10 }: { children: ReactNode; gap?: number }) =>
  <div style={{ display: "flex", flexDirection: "column", gap, padding: 14 }}>{children}</div>;

export function Footer({ children }: { children: ReactNode }) {
  return <div data-sticky-foot="" style={{ position: "sticky", bottom: 0, display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", marginTop: "auto",
    background: "var(--surface)", borderTop: "1px solid var(--hairline)" }}>{children}</div>;
}
