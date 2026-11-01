// On the map, once per session, when Google's 3D tiles failed: "3D city unavailable · showing aerial", the cause in an
// info Tooltip, Details (opens Layers at the Base map row) and ✕. It stays until dismissed or until Try 3D again works.
import type { CSSProperties } from "react";
import { Info, X } from "@phosphor-icons/react";
import { dismissPhotorealChip, focusBasemap, useLayers } from "../lib/layers";
import { downText } from "../lib/photoreal";
import { Button } from "./controls/Button";
import { Tooltip } from "./controls/Tooltip";

// The map's glass chip (as the flow and profile chips).
const chip: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, height: 28, padding: "0 4px 0 10px", background: "color-mix(in srgb, var(--ground) 84%, transparent)", backdropFilter: "blur(6px)",
  border: "1px solid color-mix(in srgb, var(--ink) 10%, transparent)", borderRadius: "var(--radius-pill)", boxShadow: "var(--shadow-float)", fontSize: 12, whiteSpace: "nowrap",
  color: "var(--ink)", pointerEvents: "auto",
};
const iconBtn: CSSProperties = { width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, border: 0, background: "transparent", color: "var(--ink-muted)", cursor: "pointer" };

/** phone: gives way to the controls and the credits like the other phone chips (data-declutter-phone); on a desktop it is
 *  an obstacle the map's labels avoid (data-declutter-block). */
export function PhotorealChip({ phone = false, style }: { phone?: boolean; style?: CSSProperties }) {
  const lay = useLayers();
  const down = lay.photorealDown;
  if (!down || lay.photorealChipDismissed) return null;
  return (
    <div {...(phone ? { "data-declutter-phone": "" } : { "data-declutter-block": "" })} style={{ ...chip, ...style }}>
      <span role="status">3D city unavailable · showing aerial</span>
      <Tooltip text={downText(down.kind)}>
        <Button variant="icon" aria-label="Why" style={iconBtn}><Info size={14} weight="bold" aria-hidden="true" /></Button>
      </Tooltip>
      <Button variant="text" onClick={focusBasemap} style={{ padding: "0 4px", border: 0, background: "transparent", font: "inherit", fontWeight: 600, color: "var(--ink)", cursor: "pointer" }}>Details</Button>
      <Button variant="icon" aria-label="Dismiss" onClick={dismissPhotorealChip} style={iconBtn}><X size={13} weight="bold" aria-hidden="true" /></Button>
    </div>
  );
}
