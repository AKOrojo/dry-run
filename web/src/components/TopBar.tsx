// Top bar (rev 5 header()): wordmark, area, storm summary, mode tabs, View/Share, theme toggle.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { CaretDown, ChatTeardropText, Check, CloudRain, Columns, DownloadSimple, Layout, Link, MapTrifold, Moon, Question, ShareNetwork, Sun } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { Checkbox, FIG } from "./rev5";
import { applyTheme, getTheme, Theme } from "../lib/theme";
import { setImageryMode, useLayers } from "../lib/layers";
import { setView, useView } from "../lib/view";

export type Mode = "Scenario" | "Compare" | "Agent";
const PATTERN_TEXT = { uniform: "uniform", front_loaded: "front-loaded", center_peaked: "centre-peaked" } as const;
const vr = <span style={{ width: 1, height: 20, background: "var(--hairline)", flex: "none" }} />;

function ModeTab({ name, Ic, active, badge, onClick }: { name: Mode; Ic: Icon; active: boolean; badge?: number; onClick: () => void }) {
  const st = active
    ? { background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", border: "1px solid var(--hairline)", fontWeight: 600 }
    : { background: "transparent", color: "var(--ink-muted)", border: "1px solid transparent" };
  return (
    <button type="button" data-tour={name === "Agent" ? "agent" : name === "Compare" ? "compare" : undefined} aria-current={active ? "page" : undefined} onClick={onClick}
      style={{ height: 28, display: "flex", alignItems: "center", gap: 7, padding: "0 12px", borderRadius: 3, font: "inherit", ...st }}>
      <Ic size={15} weight="bold" style={{ flex: "none" }} />{name}
      {!!badge && (
        <span style={{ minWidth: 18, height: 18, padding: "0 5px", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--hazard)",
          color: "var(--on-hazard)", borderRadius: "var(--radius-pill)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px var(--elev-drop)", fontSize: 11, fontWeight: 600, ...FIG }}>{badge}</span>
      )}
    </button>
  );
}

// Dropdowns follow the map's right-click menu (MapStage.tsx). Fixed position so the header's overflow does not clip them.
const menuItem: CSSProperties = {
  width: "100%", height: 28, display: "flex", alignItems: "center", gap: 9, padding: "0 9px", border: 0, borderRadius: 3,
  background: "transparent", color: "var(--ink)", font: "inherit", fontSize: 12, textAlign: "left", cursor: "pointer", whiteSpace: "nowrap",
};
const menuLabel: CSSProperties = { padding: "6px 9px 2px", color: "var(--ink-muted)", fontSize: 11 };
const menuRule = <div role="separator" style={{ height: 1, margin: "3px 0", background: "var(--hairline)" }} />;
const tick = (on: boolean) => <span style={{ width: 16, display: "flex", justifyContent: "center", flex: "none" }}>{on && <Check size={13} weight="bold" />}</span>;

function Menu({ name, Ic, children }: { name: string; Ic: Icon; children: (close: () => void) => ReactNode }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = (refocus = true) => { setAt(null); if (refocus) btn.current?.focus(); };
  useEffect(() => {
    if (!at) return;
    box.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus();
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(false); };
    const shut = () => close(false);
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", shut);
    return () => { document.removeEventListener("pointerdown", away); window.removeEventListener("resize", shut); };
  }, [at]);
  const open = () => {
    const r = btn.current!.getBoundingClientRect();
    setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 228)), top: r.bottom + 6 });
  };
  const onKey = (e: KeyboardEvent) => {
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") close(false);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  return (
    <>
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={!!at} onClick={() => (at ? close(false) : open())}
        style={{ height: 30, display: "flex", alignItems: "center", gap: 6, padding: "0 6px", background: "transparent", border: 0, color: at ? "var(--ink)" : "var(--ink-muted)", font: "inherit", cursor: "pointer" }}>
        <Ic size={15} weight="bold" />{name}<CaretDown size={12} weight="bold" />
      </button>
      {at && (
        <div ref={box} role="menu" aria-label={name} onKeyDown={onKey}
          style={{ position: "fixed", left: at.left, top: at.top, zIndex: 20, minWidth: 220, padding: 3, background: "var(--surface-raised)", border: "1px solid var(--hairline)",
            borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", color: "var(--ink)", fontWeight: 400 }}>
          {children(() => close())}
        </div>
      )}
    </>
  );
}

function ViewMenu({ theme, onTheme, onTour }: { theme: Theme; onTheme: (t: Theme) => void; onTour: () => void }) {
  const v = useView();
  const { imageryMode } = useLayers();
  const check = (label: string, on: boolean, flip: () => void) => (
    <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={flip} style={menuItem}><Checkbox on={on} />{label}</button>
  );
  const radio = (label: string, on: boolean, pick: () => void) => (
    <button type="button" role="menuitemradio" aria-checked={on} onClick={pick} style={menuItem}>{tick(on)}{label}</button>
  );
  return (
    <Menu name="View" Ic={Layout}>
      {(close) => (
        <>
          {check("Show sidebar", v.sidebar, () => setView({ sidebar: !v.sidebar }))}
          {check("Show timeline", v.timeline, () => setView({ timeline: !v.timeline }))}
          {menuRule}
          <div style={menuLabel}>Imagery</div>
          {radio("Colour", imageryMode === "colour", () => setImageryMode("colour"))}
          {radio("Greyscale", imageryMode === "greyscale", () => setImageryMode("greyscale"))}
          {menuRule}
          <div style={menuLabel}>Theme</div>
          {radio("Dark", theme === "dark", () => onTheme("dark"))}
          {radio("Light", theme === "light", () => onTheme("light"))}
          {menuRule}
          <button type="button" role="menuitem" onClick={() => { close(); onTour(); }} style={menuItem}>{tick(false)}Take the tour</button>
        </>
      )}
    </Menu>
  );
}

function ShareMenu({ onCopyLink, onSaveImage }: { onCopyLink: () => Promise<string>; onSaveImage: () => string | null }) {
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(null), 2500);
    return () => window.clearTimeout(id);
  }, [status]);
  return (
    <>
      <Menu name="Share" Ic={ShareNetwork}>
        {(close) => (
          <>
            <button type="button" role="menuitem" style={menuItem} onClick={async () => { close(); setStatus(await onCopyLink()); }}>
              <Link size={14} weight="bold" />Copy link to this view</button>
            <button type="button" role="menuitem" style={menuItem} onClick={() => { close(); setStatus(onSaveImage()); }}>
              <DownloadSimple size={14} weight="bold" />Save map image (PNG)</button>
          </>
        )}
      </Menu>
      <span role="status" aria-live="polite" style={{ color: "var(--ink-muted)", fontSize: 12, display: status ? undefined : "none" }}>{status}</span>
    </>
  );
}

export function TopBar({ aois, aoiId, onAoi, rainMm, durationH, pattern, mode, onMode, agentRuns, onTour, onCopyLink, onSaveImage }: {
  aois: { aoi_id: string; name: string }[]; aoiId?: string; onAoi: (id: string) => void;
  rainMm: number; durationH: number; pattern: keyof typeof PATTERN_TEXT;
  mode: Mode; onMode: (m: Mode) => void; agentRuns: number; onTour: () => void;
  /** Both return the short status line to show ("Link copied", or why it failed). */
  onCopyLink: () => Promise<string>; onSaveImage: () => string | null;
}) {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const pickTheme = (t: Theme) => { applyTheme(t); setTheme(t); };
  const toggle = () => pickTheme(theme === "dark" ? "light" : "dark");
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
      <span data-tour="viewshare" style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <ViewMenu theme={theme} onTheme={pickTheme} onTour={onTour} /><ShareMenu onCopyLink={onCopyLink} onSaveImage={onSaveImage} />
      </span>{vr}
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
