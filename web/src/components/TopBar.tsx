// Top bar (rev 5 header()): wordmark, area, storm summary, mode tabs, View/Share, theme toggle.
import { useState } from "react";
import { CaretDown, ChatTeardropText, CloudRain, Columns, Layout, MapTrifold, Moon, Question, ShareNetwork, Sun } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { FIG } from "./rev5";
import { applyTheme, getTheme, Theme } from "../lib/theme";

export type Mode = "Scenario" | "Compare" | "Agent";
const PATTERN_TEXT = { uniform: "uniform", front_loaded: "front-loaded", center_peaked: "centre-peaked" } as const;
const vr = <span style={{ width: 1, height: 20, background: "var(--hairline)", flex: "none" }} />;

function ModeTab({ name, Ic, active, badge, onClick }: { name: Mode; Ic: Icon; active: boolean; badge?: number; onClick: () => void }) {
  const st = active
    ? { background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", border: "1px solid var(--hairline)", fontWeight: 600 }
    : { background: "transparent", color: "var(--ink-muted)", border: "1px solid transparent" };
  return (
    <button type="button" data-tour={name === "Agent" ? "agent" : undefined} aria-current={active ? "page" : undefined} onClick={onClick}
      style={{ height: 28, display: "flex", alignItems: "center", gap: 7, padding: "0 12px", borderRadius: 3, font: "inherit", ...st }}>
      <Ic size={15} weight="bold" style={{ flex: "none" }} />{name}
      {!!badge && (
        <span style={{ minWidth: 18, height: 18, padding: "0 5px", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--hazard)",
          color: "var(--on-hazard)", borderRadius: "var(--radius-pill)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px var(--elev-drop)", fontSize: 11, fontWeight: 600, ...FIG }}>{badge}</span>
      )}
    </button>
  );
}

function Menu({ name, Ic }: { name: string; Ic: Icon }) {
  return (
    <button type="button" style={{ height: 30, display: "flex", alignItems: "center", gap: 6, padding: "0 6px", background: "transparent", border: 0, color: "var(--ink-muted)", font: "inherit" }}>
      <Ic size={15} weight="bold" />{name}<CaretDown size={12} weight="bold" />
    </button>
  );
}

export function TopBar({ aois, aoiId, onAoi, rainMm, durationH, pattern, mode, onMode, agentRuns, onTour }: {
  aois: { aoi_id: string; name: string }[]; aoiId?: string; onAoi: (id: string) => void;
  rainMm: number; durationH: number; pattern: keyof typeof PATTERN_TEXT;
  mode: Mode; onMode: (m: Mode) => void; agentRuns: number; onTour: () => void;
}) {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const toggle = () => { const t = theme === "dark" ? "light" : "dark"; applyTheme(t); setTheme(t); };
  const Toggle = theme === "dark" ? Sun : Moon;
  return (
    <header style={{ position: "relative", zIndex: 2, display: "flex", alignItems: "center", gap: 14, padding: "0 12px 0 16px", background: "var(--surface)",
      borderBottom: "1px solid var(--hairline)", boxShadow: "0 2px 8px var(--elev-drop-soft)", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }}>
      <span style={{ fontSize: 16, lineHeight: "20px", fontWeight: 700, letterSpacing: "-0.01em" }}>Dry Run</span>{vr}
      <span style={{ color: "var(--ink-muted)" }}>Flood scenario analysis</span>
      <span style={{ width: 0, height: 22, borderLeft: "1px dashed var(--hairline)", margin: "0 6px" }} />
      {aois.length > 0 && (
        <span style={{ position: "relative", display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
          <select aria-label="Area" value={aoiId ?? ""} onChange={(e) => onAoi(e.target.value)}
            style={{ appearance: "none", WebkitAppearance: "none", background: "transparent", border: 0, color: "var(--ink)", font: "inherit", fontWeight: 600, padding: "0 18px 0 0", cursor: "pointer" }}>
            {aois.map((a) => <option key={a.aoi_id} value={a.aoi_id}>{a.name}</option>)}
          </select>
          <CaretDown size={12} weight="bold" color="var(--ink-muted)" style={{ position: "absolute", right: 0, pointerEvents: "none" }} />
        </span>
      )}
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-muted)" }}>
        <CloudRain size={15} weight="bold" />
        <span style={{ color: "var(--ink)", ...FIG }}>{rainMm} mm / {durationH} h</span>{PATTERN_TEXT[pattern]} over the area
      </span>
      <nav aria-label="Mode" style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: "auto", padding: 3, background: "var(--ground)", boxShadow: "var(--inset-shadow)", borderRadius: "var(--radius-md)" }}>
        <ModeTab name="Scenario" Ic={MapTrifold} active={mode === "Scenario"} onClick={() => onMode("Scenario")} />
        <ModeTab name="Compare" Ic={Columns} active={mode === "Compare"} onClick={() => onMode("Compare")} />
        <ModeTab name="Agent" Ic={ChatTeardropText} active={mode === "Agent"} badge={agentRuns} onClick={() => onMode("Agent")} />
      </nav>
      <Menu name="View" Ic={Layout} /><Menu name="Share" Ic={ShareNetwork} />{vr}
      <button type="button" aria-label="Take the tour" title="Take the tour" onClick={onTour}
        style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: 0, color: "var(--ink-muted)", padding: 0 }}>
        <Question size={16} weight="bold" />
      </button>
      <button type="button" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggle}
        style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: 0, color: "var(--ink-muted)", padding: 0 }}>
        <Toggle size={16} weight="bold" />
      </button>
    </header>
  );
}
