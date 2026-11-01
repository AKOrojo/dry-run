// Rev 5 building blocks (ported from docs/design/rev5-ref/parts.py; same inline style values).
import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { Barricade, Drop, CloudSlash, Lock, TrafficCone, Waves } from "@phosphor-icons/react";
import { Slider } from "./controls/Slider";

export const FIG: CSSProperties = { fontVariantNumeric: "tabular-nums" };
export const mono = "var(--font-mono)";

export type EventKind = "pond" | "cut" | "surge" | "peak" | "rainstop" | "standing";
export const EVENT_ICON = {
  // Roads a planned pond closes: an intervention effect (human intent), not a flood event.
  pond: { Icon: Barricade, color: "var(--danfo)" },
  cut: { Icon: Barricade, color: "var(--hazard)" },
  surge: { Icon: TrafficCone, color: "var(--hazard)" },
  peak: { Icon: Drop, color: "var(--depth-3)" },
  rainstop: { Icon: CloudSlash, color: "var(--ink-muted)" },
  standing: { Icon: Waves, color: "var(--depth-2)" },
} as const;

/** events.json kind -> dock/map event kind and label. */
export const SERVER_EVENT = {
  pond_closure: { kind: "pond", label: "Roads closed by the planned pond" },
  first_cut: { kind: "cut", label: "First road impassable" },
  cut_jump: { kind: "surge", label: "Route cuts surge" },
  peak_area: { kind: "peak", label: "Peak flooded area" },
} as const;

/** Server event label; a pond closure carries its road count ("…: 11"). */
export const serverEventLabel = (e: { kind: keyof typeof SERVER_EVENT; count?: number }) =>
  SERVER_EVENT[e.kind].label + (e.kind === "pond_closure" && e.count != null ? `: ${e.count}` : "");

export function Glyph({ kind, muted = false, size = 16 }: { kind: EventKind; muted?: boolean; size?: number }) {
  const { Icon, color } = EVENT_ICON[kind];
  return <Icon size={size} weight="fill" color={color} aria-hidden="true" style={{ flex: "none", opacity: muted ? 0.45 : 1 }} />;
}

export const raisedButton: CSSProperties = {
  background: "var(--raised-bg)", color: "var(--ink)", border: "1px solid var(--control-edge)", boxShadow: "var(--raised-shadow)",
};

export function Band({ title, right, extra }: { title: string; right?: ReactNode; extra?: CSSProperties }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, height: 38, padding: "0 12px 0 14px", flex: "none",
      background: "linear-gradient(180deg, color-mix(in srgb, var(--surface-raised) 94%, var(--ink)) 0%, var(--surface-raised) 100%)",
      borderBottom: "1px solid var(--hairline)", boxShadow: "inset 0 1px 0 var(--elev-hi)", ...extra }}>
      <h2 style={{ margin: 0, fontSize: 14, lineHeight: "18px", fontWeight: 600 }}>{title}</h2>{right}
    </div>
  );
}

/** A band label ("Locked while simulating") that locks every Card under it: inputs dimmed and not focusable. */
export const CardLock = createContext<string | null>(null);

export function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const lock = useContext(CardLock);
  return (
    <section {...(lock ? { inert: "" } : {})} style={{ position: "relative", display: "flex", flexDirection: "column", flex: "none", background: "var(--surface)",
      border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: "var(--card-shadow)", overflow: "hidden" }}>
      <Band title={title} right={lock ? (
        <span title={lock} style={{ marginLeft: "auto", minWidth: 0, display: "flex", alignItems: "center", gap: 6, color: "var(--ink-muted)", fontSize: 12, whiteSpace: "nowrap" }}>
          <Lock size={14} weight="bold" aria-hidden="true" style={{ flex: "none" }} /><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{lock}</span>
        </span>
      ) : right} />{children}
      {lock && <div aria-hidden="true" style={{ position: "absolute", inset: "37px 0 0 0", background: "color-mix(in srgb, var(--surface) 45%, transparent)" }} />}
    </section>
  );
}

export function TextAction({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return <button type="button" onClick={onClick} style={{ marginLeft: "auto", padding: "3px 6px", background: "transparent", border: 0,
    borderRadius: "var(--radius-md)", color: "var(--ink-muted)", font: "inherit", fontSize: 12, fontWeight: 500 }}>{children}</button>;
}

export const srOnly: CSSProperties = { position: "absolute", opacity: 0, width: 1, height: 1, margin: 0, pointerEvents: "none" };

export function Checkbox({ on }: { on: boolean }) {
  if (on) {
    return (
      <span style={{ width: 16, height: 16, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--pressed-bg)",
        boxShadow: "inset 0 1px 0 var(--elev-hi), 0 1px 1px var(--elev-drop)", borderRadius: 4 }}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.2 4.1 7.2 8 3" fill="none" stroke="var(--ground)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    );
  }
  return <span style={{ width: 16, height: 16, flex: "none", border: "1.5px solid var(--control-edge)", borderRadius: 4, boxSizing: "border-box", boxShadow: "inset 0 1px 2px var(--elev-drop-soft)" }} />;
}

export function MiniSlider({ pct, label, onChange }: { pct: number; label: string; onChange: (pct: number) => void }) {
  return <Slider compact label={label} min={0} max={100} value={Math.round(pct)} text={`${Math.round(pct)}%`} onChange={onChange} />;
}

export function Segmented<T extends string>({ options, active, onChange, size = 12 }:
  { options: { value: T; label: string }[]; active: T | null; onChange: (v: T) => void; size?: number }) {
  return (
    <div style={{ display: "flex", gap: 2, padding: 3, background: "var(--ground)", borderRadius: "var(--radius-md)", boxShadow: "var(--inset-shadow)" }}>
      {options.map((o) => {
        const on = o.value === active;
        return (
          <button key={o.value} type="button" aria-pressed={on} onClick={() => onChange(o.value)}
            style={{ flex: 1, height: 26, padding: "0 8px", border: 0, borderRadius: 3, font: "inherit", fontSize: size, whiteSpace: "nowrap",
              ...(on ? { background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", fontWeight: 600 } : { background: "transparent", color: "var(--ink-muted)", fontWeight: 400 }) }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const hintText: CSSProperties = { color: "var(--ink-muted)", fontSize: 12, lineHeight: "16px" };

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="label" style={{ fontSize: 11, lineHeight: "14px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-muted)" }}>{label}</span>
      {children}
      {hint && <span style={hintText}>{hint}</span>}
    </div>
  );
}

export function NumberInput({ value, unit, min, max, step = 1, label, onChange }:
  { value: number; unit: string; min: number; max: number; step?: number; label: string; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", height: 32, padding: "0 10px", background: "var(--ground)", border: "1px solid var(--control-edge)",
      borderRadius: "var(--radius-md)", boxShadow: "inset 0 1px 2px var(--elev-drop-soft)" }}>
      <input type="number" aria-label={label} value={value} min={min} max={max} step={step}
        onChange={(e) => { const v = e.target.valueAsNumber; if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))); }}
        style={{ ...FIG, width: "100%", minWidth: 0, padding: 0, border: 0, outline: "none", background: "transparent", color: "var(--ink)", font: "inherit", fontWeight: 600 }} />
      <span style={{ marginLeft: "auto", color: "var(--ink-muted)" }}>{unit}</span>
    </label>
  );
}
