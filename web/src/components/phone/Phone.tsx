// Phone shell pieces (design board 13, under 600 px): the bottom tab bar, the sheet each tab opens (half and full
// snaps, a drag handle, tap the active tab to close) and the 56 px mini player that sits above the tab bar while a
// run is open. Same tokens and components as the desktop frame; nothing here is a new visual.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ChartBar, ChatTeardropText, CloudRain, MapPin, MapTrifold, Pause, Play } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { RunManifest } from "../../lib/api";
import { clock, useClock } from "../../lib/clock";
import { fmtT } from "../ds";
import { FIG, raisedButton } from "../rev5";

export type PhoneTab = "Scenario" | "Layers" | "Inspect" | "Timeline" | "Agent";
export type Snap = "half" | "full";
export const PHONE_TABS: { name: PhoneTab; Ic: Icon }[] = [
  { name: "Scenario", Ic: CloudRain }, { name: "Layers", Ic: MapTrifold }, { name: "Inspect", Ic: MapPin },
  { name: "Timeline", Ic: ChartBar }, { name: "Agent", Ic: ChatTeardropText },
];
export const TAB_BAR_H = 64;
export const PLAYER_H = 56;
const SHEET_ID = "dr-phone-sheet";

export const tabId = (t: PhoneTab) => `dr-tab-${t.toLowerCase()}`;

/** A tablist: the open sheet is its tabpanel. Left/Right (Home/End) move between tabs and open the one they land on. */
export function TabBar({ active, onTab, agentRuns = 0 }: { active: PhoneTab | null; onTab: (t: PhoneTab) => void; agentRuns?: number }) {
  const bar = useRef<HTMLDivElement>(null);
  const onKey = (e: ReactKeyboardEvent) => {
    const i = PHONE_TABS.findIndex((t) => tabId(t.name) === (document.activeElement as HTMLElement | null)?.id);
    if (i < 0) return;
    const n = PHONE_TABS.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    bar.current?.querySelector<HTMLElement>(`#${tabId(PHONE_TABS[to].name)}`)?.focus();
    if (PHONE_TABS[to].name !== active) onTab(PHONE_TABS[to].name);
  };
  const focusable = active ?? PHONE_TABS[0].name;
  return (
    <div ref={bar} role="tablist" aria-label="Panels" data-tour="tabbar" onKeyDown={onKey} style={{ flex: "none", display: "grid", gridTemplateColumns: `repeat(${PHONE_TABS.length}, minmax(0, 1fr))`,
      height: TAB_BAR_H, paddingBottom: "env(safe-area-inset-bottom)", background: "var(--surface)", borderTop: "1px solid var(--hairline)",
      boxShadow: "0 -2px 8px var(--elev-drop-soft)", position: "relative", zIndex: 3 }}>
      {PHONE_TABS.map(({ name, Ic }) => {
        const on = name === active;
        return (
          <button key={name} type="button" role="tab" id={tabId(name)} data-tour={`tab-${name.toLowerCase()}`} aria-selected={on} aria-controls={on ? SHEET_ID : undefined}
            tabIndex={name === focusable ? 0 : -1} onClick={() => onTab(name)}
            style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, minWidth: 0, padding: 0,
              background: "transparent", border: 0, font: "inherit", fontSize: 11, lineHeight: "14px", color: on ? "var(--ink)" : "var(--ink-muted)", fontWeight: on ? 600 : 400, cursor: "pointer" }}>
            <span style={{ position: "relative", display: "flex" }}>
              <Ic size={20} weight={on ? "bold" : "regular"} aria-hidden="true" />
              {name === "Agent" && agentRuns > 0 && (
                <span style={{ position: "absolute", top: -6, right: -10, minWidth: 16, height: 16, padding: "0 4px", display: "inline-flex", alignItems: "center", justifyContent: "center",
                  background: "var(--hazard)", color: "var(--on-hazard)", borderRadius: "var(--radius-pill)", fontSize: 11, fontWeight: 600, ...FIG }}>{agentRuns}</span>
              )}
            </span>
            <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
            {on && <span aria-hidden="true" style={{ position: "absolute", bottom: 6, left: "50%", width: 20, height: 2, marginLeft: -10, borderRadius: "var(--radius-pill)", background: "var(--danfo)" }} />}
          </button>
        );
      })}
    </div>
  );
}

const HALF_MIN = 344;

/** A bottom sheet over the map. Drag the handle between half and full height, or down past half to close. */
export function Sheet({ title, snap: snapProp, onSnap, onClose, head, hidden = false, tab, fullOnly = false, children }: {
  /** A phone on its side: no half snap, the sheet opens at full height; drag down closes it. */ fullOnly?: boolean;
  title: string; snap: Snap; onSnap: (s: Snap) => void; onClose: () => void;
  /** The tab-bar tab this sheet is the panel of. */ tab?: PhoneTab | null;
  /** Closed: still mounted, so the side panel inside keeps its state (a running agent session keeps streaming). */ hidden?: boolean;
  /** Under the title (the Timeline sheet's player). */ head?: ReactNode; children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  const [room, setRoom] = useState(0);
  const [drag, setDrag] = useState<{ y0: number; h0: number; h: number } | null>(null);
  // The sheet fills the map area above the player and the tab bar; its parent is that area.
  useLayoutEffect(() => {
    const parent = box.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(([e]) => setRoom(e.contentRect.height));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  const snap: Snap = fullOnly ? "full" : snapProp;
  // On a short phone half the room leaves a slot (an iPhone SE: 33 px above the Simulate footer), so the half sheet
  // is at least HALF_MIN tall: the 58 px header, Safari's 109 px sticky footer and about three controls above it.
  const full = Math.max(0, room - 8), half = fullOnly ? full : Math.min(full, Math.max(Math.round(room / 2), HALF_MIN));
  const target = snap === "full" ? full : half;
  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ y0: e.clientY, h0: target, h: target });
  };
  const move = (e: ReactPointerEvent) => { if (drag) setDrag({ ...drag, h: Math.min(full, Math.max(0, drag.h0 - (e.clientY - drag.y0))) }); };
  const up = (e: ReactPointerEvent) => {
    if (!drag) return;
    const moved = Math.abs(e.clientY - drag.y0) > 6;
    setDrag(null);
    if (!moved) { if (fullOnly) onClose(); else onSnap(snap === "half" ? "full" : "half"); return; }  // a tap toggles (closes when full-only)
    const h = drag.h;
    if (h < half * (fullOnly ? 0.75 : 0.6)) onClose();
    else onSnap(h > (half + full) / 2 ? "full" : "half");
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowUp") { e.preventDefault(); onSnap("full"); }
    else if (e.key === "ArrowDown") { e.preventDefault(); if (snap === "full" && !fullOnly) onSnap("half"); else onClose(); }
  };
  useEffect(() => {
    if (hidden) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, hidden]);
  const h = drag ? drag.h : target;
  return (
    <section ref={box} id={SHEET_ID} role="tabpanel" aria-labelledby={tab ? tabId(tab) : undefined} aria-label={tab ? undefined : `${title} panel`} data-sheet={snap}
      hidden={hidden} style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: room ? h : "50%", zIndex: 4, display: hidden ? "none" : "flex", flexDirection: "column",
        background: "var(--ground)", borderTop: "1px solid var(--hairline)", borderRadius: "8px 8px 0 0", boxShadow: "var(--shadow-float)", overflow: "hidden",
        transition: drag ? "none" : "height 0.2s ease-out" }}>
      <div onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)}
        style={{ position: "relative", flex: "none", touchAction: "none", cursor: "grab", background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}>
        {/* The handle's target is the top 40 px of the header; the title sits under its lower half. */}
        <button type="button" onKeyDown={onKey} onClick={(e) => { if (e.detail === 0) { if (fullOnly) onClose(); else onSnap(snap === "half" ? "full" : "half"); } }}
          aria-label={fullOnly ? `Close the ${title} panel` : snap === "half" ? `Expand the ${title} panel` : `Shrink the ${title} panel`}
          style={{ position: "absolute", left: 0, right: 0, top: 0, display: "flex", height: 40, alignItems: "flex-start", justifyContent: "center", padding: "8px 0 0", background: "transparent", border: 0, cursor: "inherit", zIndex: 1 }}>
          <span aria-hidden="true" style={{ width: 36, height: 4, borderRadius: "var(--radius-pill)", background: "var(--control-edge)" }} />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, height: 30, padding: "20px 14px 6px" }}>
          <h2 style={{ margin: 0, fontSize: 14, lineHeight: "18px", fontWeight: 600 }}>{title}</h2>
        </div>
        {head}
      </div>
      <div className="dr-sheet-body" style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div>
    </section>
  );
}

const nearest = (ts: number[], t: number) => ts.reduce((best, v, i) => (Math.abs(v - t) < Math.abs(ts[best] - t) ? i : best), 0);

/** Play/pause, the clock, a scrubber and the headline number (flooded area at the playhead). */
export function MiniPlayer({ run, inline = false }: { run: RunManifest; /** Inside the Timeline sheet: no top border, no own background. */ inline?: boolean }) {
  const { t_s, playing } = useClock();
  const ts = run.timeseries;
  const durS = ts && ts.t_s.length > 1 ? ts.t_s[ts.t_s.length - 1] : (run.frames.at(-1)?.t_s ?? 0);
  const track = useRef<HTMLDivElement>(null);
  const pct = durS > 0 ? Math.min(100, (100 * t_s) / durS) : 0;
  const head = ts && ts.t_s.length ? ts.flooded_area_km2[nearest(ts.t_s, t_s)] : null;
  const seek = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    clock.set({ t_s: Math.min(1, Math.max(0, (x - r.left) / r.width)) * durS, playing: false });
  };
  const step = Math.max(60, durS / 36);
  const onKey = (e: ReactKeyboardEvent) => {
    const k = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step } as Record<string, number>;
    if (e.key in k) { e.preventDefault(); clock.set({ t_s: t_s + k[e.key], playing: false }); }
    else if (e.key === "Home") { e.preventDefault(); clock.set({ t_s: 0, playing: false }); }
    else if (e.key === "End") { e.preventDefault(); clock.set({ t_s: durS, playing: false }); }
  };
  const shell: CSSProperties = inline
    ? { display: "flex", alignItems: "center", gap: 12, height: PLAYER_H, padding: "0 14px" }
    : { flex: "none", display: "flex", alignItems: "center", gap: 12, height: PLAYER_H, padding: "0 14px", background: "var(--surface)", borderTop: "1px solid var(--hairline)", position: "relative", zIndex: 3 };
  return (
    <div data-tour="player" role="group" aria-label="Run player" style={shell}>
      <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={() => clock.set(playing ? { playing: false } : t_s >= durS ? { t_s: 0, playing: true } : { playing: true })}
        style={{ width: 40, height: 40, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, borderRadius: "var(--radius-md)", ...raisedButton, cursor: "pointer" }}>
        {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="bold" />}
      </button>
      <span style={{ flex: "none", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, ...FIG }}>{fmtT(t_s)}</span>
      <div ref={track} role="slider" tabIndex={0} aria-label="Time in the run" aria-valuemin={0} aria-valuemax={Math.round(durS)} aria-valuenow={Math.round(t_s)} aria-valuetext={fmtT(t_s)}
        onKeyDown={onKey} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e.clientX); }} onPointerMove={(e) => { if (e.buttons) seek(e.clientX); }}
        style={{ position: "relative", flex: "1 1 auto", minWidth: 0, height: 40, cursor: "pointer", touchAction: "none" }}>
        <span style={{ position: "absolute", left: 0, right: 0, top: 18, height: 4, background: "var(--ground)", borderRadius: "var(--radius-pill)", boxShadow: "var(--inset-shadow)" }} />
        <span style={{ position: "absolute", left: 0, width: `${pct}%`, top: 18, height: 4, background: "var(--danfo)", borderRadius: "var(--radius-pill)" }} />
        <span style={{ position: "absolute", left: `${pct}%`, top: 12, width: 16, height: 16, marginLeft: -8, borderRadius: "50%", ...raisedButton }} />
      </div>
      {head != null && <span style={{ flex: "none", color: "var(--ink-muted)", fontSize: 12, ...FIG }}>{head.toFixed(1)} km²</span>}
    </div>
  );
}
