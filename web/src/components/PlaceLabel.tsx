// A named place on the map: a dot and a chip with the name and, on a desktop, its wet status lines. The status lines are
// part of the button's accessible name ("Ajah 10 % wet at T+01:40"), so no aria-label: the status is why the label exists.
import type { CSSProperties } from "react";
import { Button } from "./controls/Button";

const FIG: CSSProperties = { fontVariantNumeric: "tabular-nums" };

export function PlaceLabel({ name, sub, selected, onClick }: { name: string; sub?: string[]; selected: boolean; onClick: () => void }) {
  return (
    // Only the chip takes clicks: the dot and the gap stay click-through, so a building under them can be picked.
    <Button variant="text" type="button" className="dr-place-label" onClick={onClick} aria-pressed={selected}
      style={{ position: "absolute", left: 0, top: 0, transform: "translate(-4px, -50%)", display: "flex", alignItems: "center", gap: 8, padding: 0, background: "transparent",
        border: 0, font: "inherit", color: "var(--ink)", textAlign: "left", cursor: "pointer", pointerEvents: "none" }}>
      <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: "var(--ink)", boxShadow: "0 0 0 2px var(--ground)" }} />
      <span style={{ display: "flex", flexDirection: "column", padding: "4px 9px 5px", background: "color-mix(in srgb, var(--ground) 84%, transparent)", backdropFilter: "blur(6px)",
        border: selected ? "1px solid var(--danfo)" : "1px solid color-mix(in srgb, var(--ink) 10%, transparent)", borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-float)", whiteSpace: "nowrap", pointerEvents: "auto" }} data-declutter={selected ? 5 : 1} data-place="">
        <span style={{ fontSize: 12, lineHeight: "16px", fontWeight: 600 }}>{name}</span>
        {sub?.map((l) => <span key={l} style={{ color: "var(--ink-muted)", fontSize: 11, lineHeight: "14px", ...FIG }}>{l}</span>)}
      </span>
    </Button>
  );
}
