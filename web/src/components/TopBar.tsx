// Top bar (rev 5 header()): wordmark, area, storm summary, mode tabs, View/Share, theme toggle.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { CaretDown, ChatTeardropText, CloudRain, Columns, Crosshair, DotsThreeVertical, DownloadSimple, Info, Layout, Link, MapTrifold, Moon, Question, ShareNetwork, Sun } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { FIG } from "./rev5";
import { Select } from "./controls/Select";
import type { SelectGroup } from "./controls/Select";
import { areaDetail, areaFacts } from "../lib/areas";
import type { AreaFacts } from "../lib/areas";
import { applyTheme, getTheme, Theme } from "../lib/theme";
import { setImageryMode, setLayer, useLayers } from "../lib/layers";
import { setView, useView } from "../lib/view";
import type { Breakpoint } from "../lib/breakpoint";
import { Tooltip } from "./controls/Tooltip";
import { Menu } from "./controls/Menu";
import type { MenuEntry, MenuTriggerProps } from "./controls/Menu";

export type Mode = "Scenario" | "Compare" | "Agent";
const PATTERN_TEXT = { uniform: "uniform", front_loaded: "front-loaded", center_peaked: "centre-peaked" } as const;
const vr = <span style={{ width: 1, height: 20, background: "var(--hairline)", flex: "none" }} />;

function ModeTab({ name, Ic, active, badge, onClick, h = 28 }: { name: Mode; Ic: Icon; active: boolean; badge?: number; onClick: () => void; /** 40 on a tablet (touch). */ h?: number }) {
  const st = active
    ? { background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", border: "1px solid var(--hairline)", fontWeight: 600 }
    : { background: "transparent", color: "var(--ink-muted)", border: "1px solid transparent" };
  return (
    <button type="button" data-tour={name === "Agent" ? "agent" : name === "Compare" ? "compare" : undefined} aria-current={active ? "page" : undefined} onClick={onClick}
      style={{ height: h, display: "flex", alignItems: "center", gap: 7, padding: "0 12px", borderRadius: 3, font: "inherit", ...st }}>
      <Ic size={15} weight="bold" style={{ flex: "none" }} />{name}
      {!!badge && (
        <span style={{ minWidth: 18, height: 18, padding: "0 5px", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--hazard)",
          color: "var(--on-hazard)", borderRadius: "var(--radius-pill)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px var(--elev-drop)", fontSize: 11, fontWeight: 600, ...FIG }}>{badge}</span>
      )}
    </button>
  );
}

const iconBtn: CSSProperties = { width: 40, height: 40, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, background: "transparent",
  border: 0, borderRadius: "var(--radius-md)", cursor: "pointer" };

// The header's menus (board 11 Menu): View, Share, and the ⋮ overflow on a phone or tablet.
const headerTrigger = (name: string, Ic: Icon) => (p: MenuTriggerProps) => (
  <button {...p} type="button" style={{ height: 30, display: "flex", alignItems: "center", gap: 6, padding: "0 6px", background: "transparent", border: 0,
    color: p["aria-expanded"] ? "var(--ink)" : "var(--ink-muted)", font: "inherit", cursor: "pointer" }}>
    <Ic size={15} weight="bold" />{name}<CaretDown size={12} weight="bold" />
  </button>
);

function ViewMenu({ theme, onTheme, onTour }: { theme: Theme; onTheme: (t: Theme) => void; onTour: () => void }) {
  const v = useView();
  const lay = useLayers();
  const { imageryMode } = lay;
  return (
    <Menu label="View" trigger={headerTrigger("View", Layout)} items={[
      { kind: "check", label: "Show sidebar", checked: v.sidebar, keepOpen: true, onSelect: () => setView({ sidebar: !v.sidebar }) },
      { kind: "check", label: "Show timeline", checked: v.timeline, keepOpen: true, onSelect: () => setView({ timeline: !v.timeline }) },
      { kind: "check", label: "Coordinates", checked: v.coords, keepOpen: true, onSelect: () => setView({ coords: !v.coords }) },
      { kind: "check", label: "Clouds and rain", checked: lay.weather.on, keepOpen: true, onSelect: () => setLayer("weather", { on: !lay.weather.on }) },
      { kind: "separator" },
      { kind: "caption", label: "Imagery" },
      { kind: "radio", label: "Colour", checked: imageryMode === "colour", keepOpen: true, onSelect: () => setImageryMode("colour") },
      { kind: "radio", label: "Greyscale", checked: imageryMode === "greyscale", keepOpen: true, onSelect: () => setImageryMode("greyscale") },
      { kind: "separator" },
      { kind: "caption", label: "Theme" },
      { kind: "radio", label: "Dark", checked: theme === "dark", keepOpen: true, onSelect: () => onTheme("dark") },
      { kind: "radio", label: "Light", checked: theme === "light", keepOpen: true, onSelect: () => onTheme("light") },
      { kind: "separator" },
      { kind: "item", label: "Take the tour", onSelect: onTour },
    ]} />
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
      <Menu label="Share" trigger={headerTrigger("Share", ShareNetwork)} items={[
        { kind: "item", label: "Copy link to this view", icon: <Link size={16} weight="bold" />, onSelect: async () => setStatus(await onCopyLink()) },
        { kind: "item", label: "Save map image (PNG)", icon: <DownloadSimple size={16} weight="bold" />, onSelect: () => setStatus(onSaveImage()) },
      ]} />
      <span role="status" aria-live="polite" style={{ color: "var(--ink-muted)", fontSize: 12, display: status ? undefined : "none" }}>{status}</span>
    </>
  );
}

/** The ⋮ menu on a phone or tablet: the header items that do not fit (board 13). A phone also gets the mode here; a
 *  tablet keeps the mode switch in the header and the View options (the side panel is the drawer button). */
function OverflowMenu({ layout, mode, onMode, agentRuns, storm, theme, onTheme, onTour, onCopyLink, onSaveImage }: {
  layout: "phone" | "tablet"; mode: Mode; onMode: (m: Mode) => void; agentRuns: number; storm: string;
  theme: Theme; onTheme: (t: Theme) => void; onTour: () => void; onCopyLink: () => Promise<string>; onSaveImage: () => string | null;
}) {
  const v = useView();
  const lay = useLayers();
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(null), 2500);
    return () => window.clearTimeout(id);
  }, [status]);
  const items: MenuEntry[] = [];
  if (layout === "phone") items.push(
    { kind: "caption", label: "Mode" },
    { kind: "radio", label: "Scenario", checked: mode === "Scenario", onSelect: () => onMode("Scenario") },
    { kind: "radio", label: "Compare", checked: mode === "Compare", onSelect: () => onMode("Compare") },
    { kind: "radio", label: "Agent", checked: mode === "Agent", hint: agentRuns ? `${agentRuns} ${agentRuns === 1 ? "run" : "runs"}` : undefined, onSelect: () => onMode("Agent") },
    { kind: "separator" });
  items.push(
    { kind: "item", label: `Storm: ${storm}`, icon: <CloudRain size={16} weight="bold" />, disabled: true, onSelect: () => {} },
    { kind: "item", label: "Share link", icon: <ShareNetwork size={16} weight="bold" />, onSelect: async () => setStatus(await onCopyLink()) },
    { kind: "item", label: "Save map image", icon: <DownloadSimple size={16} weight="bold" />, onSelect: () => setStatus(onSaveImage()) },
    { kind: "separator" });
  if (layout === "tablet") items.push(
    { kind: "check", label: "Show timeline", checked: v.timeline, keepOpen: true, onSelect: () => setView({ timeline: !v.timeline }) },
    { kind: "check", label: "Clouds and rain", checked: lay.weather.on, keepOpen: true, onSelect: () => setLayer("weather", { on: !lay.weather.on }) },
    { kind: "caption", label: "Imagery" },
    { kind: "radio", label: "Colour", checked: lay.imageryMode === "colour", keepOpen: true, onSelect: () => setImageryMode("colour") },
    { kind: "radio", label: "Greyscale", checked: lay.imageryMode === "greyscale", keepOpen: true, onSelect: () => setImageryMode("greyscale") },
    { kind: "separator" });
  items.push(
    { kind: "check", label: "Show coordinates", icon: <Crosshair size={16} weight="bold" />, hint: v.coords ? "on" : "off", checked: v.coords, keepOpen: true, onSelect: () => setView({ coords: !v.coords }) },
    { kind: "item", label: "Quick tour", icon: <Info size={16} weight="bold" />, onSelect: onTour },
    { kind: "check", label: "Dark theme", icon: <Moon size={16} weight="bold" />, hint: theme === "dark" ? "on" : "off", checked: theme === "dark", keepOpen: true, onSelect: () => onTheme(theme === "dark" ? "light" : "dark") });
  return (
    <>
      <Menu label="More" items={items} trigger={(p) => (
        <Tooltip text="More">
          <button {...p} type="button" data-tour="menu" aria-label="More"
            style={{ ...iconBtn, color: p["aria-expanded"] ? "var(--ink)" : "var(--ink-muted)" }}>
            <DotsThreeVertical size={18} weight="bold" />
          </button>
        </Tooltip>
      )} />
      {status && <span role="status" aria-live="polite" style={{ position: "fixed", top: 54, right: 12, zIndex: 20, maxWidth: "calc(100vw - 24px)", padding: "6px 10px", whiteSpace: "normal",
        background: "var(--surface-raised)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", color: "var(--ink)", fontSize: 12 }}>{status}</span>}
    </>
  );
}

/** The area picker (board 11): areas with what each models, and the open area under "Earlier versions" when a shared
 *  link opened one that has since been replaced. */
function AreaSelect({ aois, aoiId, aoiName, defaultAoi, onAoi }: { aois: { aoi_id: string; name: string }[]; aoiId?: string; aoiName?: string;
  defaultAoi?: string; onAoi: (id: string) => void }) {
  const [facts, setFacts] = useState<Record<string, AreaFacts>>({});
  const load = () => aois.forEach((a) => { void areaFacts(a.aoi_id).then((f) => setFacts((m) => (m[a.aoi_id] === f ? m : { ...m, [a.aoi_id]: f }))); });
  const groups: SelectGroup[] = [{ caption: "Areas", options: aois.map((a) => ({ value: a.aoi_id, label: a.name, detail: areaDetail(facts[a.aoi_id], a.aoi_id === defaultAoi) })) }];
  if (aoiId && !aois.some((a) => a.aoi_id === aoiId))
    groups.push({ caption: "Earlier versions", options: [{ value: aoiId, label: `${aoiName ?? aoiId} (earlier version)`, detail: "Opened from a shared link" }] });
  return <Select variant="header" label="Area" tour="area" value={aoiId} onChange={onAoi} groups={groups} onOpen={load} />;
}

export function TopBar({ rainText, aois, aoiId, aoiName, defaultAoi, onAoi, rainMm, durationH, pattern, mode, onMode, agentRuns, onTour, onCopyLink, onSaveImage, layout = "desktop", drawerOpen = false, onDrawer }: {
  /** Board 13: a phone keeps the name, the area and a ⋮ menu; a tablet adds the mode switch and the side-panel drawer button. */
  layout?: Breakpoint; drawerOpen?: boolean; onDrawer?: () => void;
  aois: { aoi_id: string; name: string }[]; aoiId?: string; onAoi: (id: string) => void;
  /** The open area's name (it may be an earlier version that is not in `aois`, opened from a shared link). */ aoiName?: string; defaultAoi?: string;
  rainMm: number; durationH: number; pattern: keyof typeof PATTERN_TEXT; /** Where the rain falls, or null for "pattern over the area". */ rainText?: string | null;
  mode: Mode; onMode: (m: Mode) => void; agentRuns: number; onTour: () => void;
  /** Both return the short status line to show ("Link copied", or why it failed). */
  onCopyLink: () => Promise<string>; onSaveImage: () => string | null;
}) {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const pickTheme = (t: Theme) => { applyTheme(t); setTheme(t); };
  const toggle = () => pickTheme(theme === "dark" ? "light" : "dark");
  const Toggle = theme === "dark" ? Sun : Moon;
  if (layout !== "desktop") {
    const storm = `${rainMm} mm / ${durationH} h, ${rainText ?? PATTERN_TEXT[pattern]}`;
    return (
      <header style={{ position: "relative", zIndex: 5, display: "flex", alignItems: "center", gap: layout === "phone" ? 8 : 12, padding: "0 4px 0 12px", background: "var(--surface)",
        borderBottom: "1px solid var(--hairline)", boxShadow: "0 2px 8px var(--elev-drop-soft)", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }}>
        <span style={{ flex: "none", fontSize: 16, lineHeight: "20px", fontWeight: 700, letterSpacing: "-0.01em" }}>Dry Run</span>
        {aois.length > 0 && <span style={{ display: "flex", minWidth: 0, flex: "0 1 auto" }}><AreaSelect aois={aois} aoiId={aoiId} aoiName={aoiName} defaultAoi={defaultAoi} onAoi={onAoi} /></span>}
        <span style={{ marginLeft: "auto" }} />
        {layout === "tablet" && <>
          <nav aria-label="Mode" style={{ display: "flex", alignItems: "center", gap: 2, flex: "none", padding: 2, background: "var(--ground)", boxShadow: "var(--inset-shadow)", borderRadius: "var(--radius-md)" }}>
            <ModeTab name="Scenario" Ic={MapTrifold} active={mode === "Scenario"} onClick={() => onMode("Scenario")} h={40} />
            <ModeTab name="Compare" Ic={Columns} active={mode === "Compare"} onClick={() => onMode("Compare")} h={40} />
            <ModeTab name="Agent" Ic={ChatTeardropText} active={mode === "Agent"} badge={agentRuns} onClick={() => onMode("Agent")} h={40} />
          </nav>
          <Tooltip text="Side panel"><button type="button" data-tour="viewshare" aria-label={drawerOpen ? "Hide the side panel" : "Show the side panel"} aria-expanded={drawerOpen} onClick={onDrawer}
            style={{ ...iconBtn, ...(drawerOpen ? { background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)" } : { color: "var(--ink-muted)" }) }}>
            <Layout size={18} weight="bold" />
          </button></Tooltip>
        </>}
        <OverflowMenu layout={layout} mode={mode} onMode={onMode} agentRuns={agentRuns} storm={storm} theme={theme} onTheme={pickTheme} onTour={onTour}
          onCopyLink={onCopyLink} onSaveImage={onSaveImage} />
      </header>
    );
  }
  return (
    <header style={{ position: "relative", zIndex: 2, display: "flex", alignItems: "center", gap: 14, padding: "0 12px 0 16px", background: "var(--surface)",
      borderBottom: "1px solid var(--hairline)", boxShadow: "0 2px 8px var(--elev-drop-soft)", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden" }}>
      <span style={{ fontSize: 16, lineHeight: "20px", fontWeight: 700, letterSpacing: "-0.01em" }}>Dry Run</span>
      {/* The tagline gives way to the area picker on a phone (app.css). */}
      <span className="dr-tagline">{vr}<span style={{ color: "var(--ink-muted)" }}>Flood scenario analysis</span>
        <span style={{ width: 0, height: 22, borderLeft: "1px dashed var(--hairline)", margin: "0 6px" }} /></span>
      {aois.length > 0 && <AreaSelect aois={aois} aoiId={aoiId} aoiName={aoiName} defaultAoi={defaultAoi} onAoi={onAoi} />}
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-muted)" }}>
        <CloudRain size={15} weight="bold" />
        <span style={{ color: "var(--ink)", ...FIG }}>{rainMm} mm / {durationH} h</span>{rainText ?? `${PATTERN_TEXT[pattern]} over the area`}
      </span>
      <nav aria-label="Mode" style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: "auto", padding: 3, background: "var(--ground)", boxShadow: "var(--inset-shadow)", borderRadius: "var(--radius-md)" }}>
        <ModeTab name="Scenario" Ic={MapTrifold} active={mode === "Scenario"} onClick={() => onMode("Scenario")} />
        <ModeTab name="Compare" Ic={Columns} active={mode === "Compare"} onClick={() => onMode("Compare")} />
        <ModeTab name="Agent" Ic={ChatTeardropText} active={mode === "Agent"} badge={agentRuns} onClick={() => onMode("Agent")} />
      </nav>
      <span data-tour="viewshare" style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <ViewMenu theme={theme} onTheme={pickTheme} onTour={onTour} /><ShareMenu onCopyLink={onCopyLink} onSaveImage={onSaveImage} />
      </span>{vr}
      <Tooltip text="Take the tour"><button type="button" aria-label="Take the tour" onClick={onTour}
        style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: 0, color: "var(--ink-muted)", padding: 0 }}>
        <Question size={16} weight="bold" />
      </button></Tooltip>
      <button type="button" aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggle}
        style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: 0, color: "var(--ink-muted)", padding: 0 }}>
        <Toggle size={16} weight="bold" />
      </button>
    </header>
  );
}
