// First-visit quick tour: dim scrim, a ring around the target ([data-tour="<id>"]) and a small card beside it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { Band } from "./rev5";
import { markTourDone as markDone } from "../lib/tour";
import type { Breakpoint } from "../lib/breakpoint";
import { Button } from "./controls/Button";

const CARD_W = 300;
const GAP = 14;
const PAD = 6;
const MARGIN = 12;
/** Phone and tablet: how long a step looks for its target in a sheet or drawer (lazy cards) before it is skipped. */
const SEARCH_MS = 1500;

const ALL_STEPS = [
  { id: "area", title: "Pick the area", body: "Switch areas here. Each one says what its drains are and whether its demo run is cached, so it opens at once." },
  { id: "scenario", title: "Set up a storm", body: "Choose rain total, duration and pattern, and the lagoon level on coastal areas." },
  { id: "rain", title: "Choose where it rains", body: "Place a storm cell, draw an area or pick a place, and see the rain before you simulate." },
  { id: "rain-domain", title: "Simulate just the rain area", body: "With a storm cell, drawn area or place, simulate only where it rains for a faster run. Outside that area is dimmed after the run." },
  { id: "drainage", title: "Set the drains", body: "Choose the drain system, how much rain it takes, how blocked it is and where it empties; the Drains layer and the timeline then show it filling." },
  { id: "simulate", title: "Run the flood model", body: "Simulate runs the storm on the 30 m model and fills the map and timeline." },
  { id: "coords", title: "Watch the storm", body: "While it simulates, the cloud and rain follow your storm. The coordinates show where you point; type a lat, lon to go there." },
  { id: "sim-status", title: "Cached or live, then stop or clear", body: "This says whether a run opens instantly or how long it takes live, and how long until it starts when another run is ahead; while it runs the storm locks, Stop cancels it and Clear simulation empties the map." },
  { id: "map", title: "Read the water", body: "Hover for depth at any point. Click to pin it and follow it over time." },
  { id: "camera", title: "Move like a 3D app", body: "Right-drag or Ctrl+drag to orbit, Free to fly with WASD, or draw a route and fly along it." },
  { id: "saferoute", anchor: "map", title: "Find a dry route", body: "Right-click the map, or press Shift+F10 on it, and pick Safe route from here: the way to the nearest shelter that is dry at the moment the playhead shows, and it updates as you move it." },
  { id: "timeline", title: "Scrub through the storm", body: "Play or drag the timeline. Key events jump to the moment and place they happen. The ⋮ on a chart shows its numbers as a table, copies them or saves the chart as an image." },
  { id: "marks", title: "Mark places and moments", body: "Right-click the map, or press Shift+F10 on it, to drop a waypoint; + Note pins a note at the playhead." },
  { id: "layers", title: "Choose the base map", body: "In Layers, switch between Photoreal 3D and Aerial. Aerial uses Bing; judges can switch it to Google with the judge key." },
  { id: "flow", title: "Read flow and hazard", body: "Turn on flow arrows, the AIDR hazard rating and loads on buildings, or draw a line to see depth along it." },
  { id: "gpu3d", title: "3D on your GPU", body: "Solve a 3D close-up of any box on your own graphics card; nothing is uploaded. No run open yet? Open the demo run, pick the box on the map, then Run 3D here." },
  { id: "viewshare", title: "Change the view or share it", body: "View hides panels and switches imagery or theme; Share copies a link to this moment or saves the map as an image." },
  { id: "plan", title: "Inspect a building", body: "Switch to the 2D plan view and click a building for its depths and the street beside it." },
  { id: "closeup", title: "See it up close in 3D", body: "Where a 3D close-up exists, open it to see the water surface, flow and the force of water on each building." },
  { id: "compare", title: "Compare two runs", body: "Pick runs A and B, then swipe, set side by side or difference their water on the map." },
  { id: "agent", title: "Ask the planning agent", body: "Give it a goal: it runs scenarios, charts every run against the others and writes a brief you can check." },
  { id: "voice", anchor: "agent", title: "Say it instead of typing", body: "In Agent, press the mic in the goal box and speak; pause or press it again to stop. The words fill the box so you can fix them before you ask. Voice needs the judge key." },
] as const;
type Step = { id: string; title: string; body: string; /** The element to ring, when it is not [data-tour=id]. */ anchor?: string };

// Board 13. A phone has no sidebar tabs, mode switch or coordinate chip: steps point at the tab bar (the tour opens the
// sheet a step is in), the ⋮ menu and the right-edge map buttons, and talk about fingers, not a mouse.
const TOUCH_TEXT: Record<string, Partial<Step>> = {
  map: { body: "Tap anywhere for the depth there and how it changes over time." },
  marks: { body: "Long-press the map to drop a waypoint; + Note pins a note at the playhead." },
  camera: { body: "One finger pans, two fingers rotate and tilt, pinch zooms. Free flies, Plan looks straight down, and a drawn route can be flown along." },
  saferoute: { body: "Long-press the map and pick Safe route from here: the way to the nearest shelter that is dry at the moment the playhead shows, and it updates as you move it." },
};
const PHONE_STEPS: Step[] = [
  ALL_STEPS[0],
  { id: "tabbar", title: "Panels live down here", body: "Scenario, Layers, Inspect, Timeline and Agent each open a sheet over the map. Drag its handle up for full height or down to close; tap the active tab to close it." },
  { ...ALL_STEPS.find((x) => x.id === "scenario")!, anchor: "tab-scenario" },
  ...ALL_STEPS.filter((x) => ["rain", "rain-domain", "drainage"].includes(x.id)),
  { ...ALL_STEPS.find((x) => x.id === "simulate")!, body: "Simulate stays at the bottom of the Scenario sheet. It runs the storm on the model and fills the map and the timeline." },
  ALL_STEPS.find((x) => x.id === "sim-status")!,
  { id: "player", title: "Play the run", body: "With a run open, the player above the tabs plays and scrubs it. The number is the flooded area at that moment." },
  { ...ALL_STEPS.find((x) => x.id === "map")!, ...TOUCH_TEXT.map },
  { ...ALL_STEPS.find((x) => x.id === "camera")!, ...TOUCH_TEXT.camera },
  { ...ALL_STEPS.find((x) => x.id === "saferoute")!, ...TOUCH_TEXT.saferoute },
  { id: "plan", title: "Inspect a building", body: "Tap 3D to switch to the 2D plan view, then tap a building for its depths and the street beside it." },
  { id: "legend", title: "What the colours mean", body: "The legend button opens the legends of the layers that are on." },
  { id: "timeline", anchor: "tab-timeline", title: "Charts, events and notes", body: "The Timeline sheet has the charts and the key events. Tap an event to jump to the moment and place it happens; + Note pins a note at the playhead, and a long press on the map drops a waypoint. The ⋮ on a chart shows its numbers as a table, copies them or saves the chart as an image." },
  { ...ALL_STEPS.find((x) => x.id === "layers")!, anchor: "tab-layers", body: "In Layers, switch between Photoreal 3D and Aerial and turn layers on. Sources and credits are linked at the end." },
  ...ALL_STEPS.filter((x) => ["flow", "gpu3d", "closeup"].includes(x.id)),
  { id: "menu", title: "More in the menu", body: "Switch between Scenario, Compare and Agent, see the storm, share a link, save the map image, show coordinates, retake this tour or change the theme." },
  { ...ALL_STEPS.find((x) => x.id === "agent")!, anchor: "tab-agent" },
  { ...ALL_STEPS.find((x) => x.id === "voice")!, anchor: "tab-agent", body: "In Agent, tap the mic in the goal box and speak; pause or tap it again to stop. The words fill the box so you can fix them before you ask. Voice needs the judge key." },
];
const TABLET_TEXT: Record<string, Partial<Step>> = {
  viewshare: { title: "The side panel and the menu", body: "This button opens Layers, Inspect, Scenario, Sources and Timeline as a panel over the map; tap outside it to close. The ⋮ menu shares a link, saves the map image and changes the view or theme." },
  timeline: { body: "Play or drag the timeline. The key events and the third chart are in the side panel's Timeline tab. The ⋮ on a chart shows its numbers as a table, copies them or saves the chart as an image." },
};
function stepsFor(layout: Breakpoint, touch: boolean): Step[] {
  if (layout === "phone") return PHONE_STEPS;
  const steps: Step[] = ALL_STEPS.map((x) => ({ ...x }));
  return steps.map((x) => ({ ...x, ...(layout === "tablet" ? TABLET_TEXT[x.id] : {}), ...(touch ? TOUCH_TEXT[x.id] : {}) }));
}
/** Steps whose anchor is only on the page sometimes (a run with a 3D close-up) are left out when it is not there. */
const OPTIONAL = new Set<string>(["closeup", "flow", "rain-domain", "gpu3d", "drainage", "player"]);
/** Steps whose card sits on another sidebar tab: the tour opens that tab (a click on this anchor) when it gets there. */
const VIA: Record<string, string> = { flow: "layers", gpu3d: "layers" };
/** Phone and tablet: these steps are in a sheet or drawer the tour opens first, so they are checked when reached. */
const IN_PANEL = new Set<string>(["flow", "rain-domain", "gpu3d", "drainage"]);
const stepsOnPage = (all: readonly Step[], narrow: boolean): readonly Step[] => all.filter((st) => !OPTIONAL.has(st.id) || document.querySelector(`[data-tour="${st.anchor ?? st.id}"]`)
  || (VIA[st.id] && document.querySelector(`[data-tour="${VIA[st.id]}"]`)) || (narrow && IN_PANEL.has(st.id)));


type Box = { left: number; top: number; width: number; height: number };
const findTarget = (id: string): Box | null => {
  const el = document.querySelector<HTMLElement>(`[data-tour="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
};

function place(t: Box | null, cardH: number): { left: number; top: number } {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (!t) return { left: (vw - CARD_W) / 2, top: Math.max(MARGIN, (vh - cardH) / 2) };
  const clampX = (x: number) => Math.min(Math.max(MARGIN, x), vw - CARD_W - MARGIN);
  const clampY = (y: number) => Math.min(Math.max(MARGIN, y), vh - cardH - MARGIN);
  const cx = t.left + t.width / 2 - CARD_W / 2, cy = t.top + t.height / 2 - cardH / 2;
  const small = t.height < vh * 0.5;
  if (small && t.top + t.height + GAP + cardH + MARGIN <= vh) return { left: clampX(cx), top: t.top + t.height + GAP };
  if (small && t.top - GAP - cardH >= MARGIN) return { left: clampX(cx), top: t.top - GAP - cardH };
  if (t.left - GAP - CARD_W >= MARGIN) return { left: t.left - GAP - CARD_W, top: clampY(cy) };
  if (t.left + t.width + GAP + CARD_W + MARGIN <= vw) return { left: t.left + t.width + GAP, top: clampY(cy) };
  return { left: clampX(cx), top: clampY(cy) };
}

export function Tour({ onClose, layout: shell = "desktop", onStep }: { onClose: () => void; layout?: Breakpoint;
  /** Phone and tablet: open the sheet or drawer step `id` points into (an empty id closes it). */ onStep?: (id: string) => void }) {
  const [i, setI] = useState(0);
  const dir = useRef(1);
  const narrow = shell !== "desktop";
  // While a step's sheet or drawer opens, the card waits out of sight (no flash of a card with nothing ringed).
  const [searching, setSearching] = useState(false);
  const stepTo = useRef(onStep);
  stepTo.current = onStep;
  const [target, setTarget] = useState<Box | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: MARGIN, top: MARGIN });
  const cardRef = useRef<HTMLElement>(null);
  const [STEPS] = useState(() => stepsOnPage(stepsFor(shell, !!window.matchMedia?.("(pointer: coarse)").matches), narrow));
  const last = i === STEPS.length - 1;
  const step = STEPS[i];

  const finish = useCallback(() => { markDone(); stepTo.current?.(""); onClose(); }, [onClose]);
  const next = useCallback(() => { dir.current = 1; if (last) finish(); else setI((n) => n + 1); }, [last, finish]);
  const back = useCallback(() => { dir.current = -1; setI((n) => Math.max(0, n - 1)); }, []);

  const measure = useCallback(() => {
    const t = findTarget(step.anchor ?? step.id);
    setTarget(t);
    setPos(place(t, cardRef.current?.offsetHeight ?? 190));
    return t;
  }, [step]);
  const layoutNarrow = useCallback(() => {
    stepTo.current?.(step.id);
    // The sheet or drawer renders on the next frames, and its cards may still be loading: look for up to SEARCH_MS.
    const t0 = performance.now();
    let raf = 0;
    setSearching(true);
    const look = () => {
      document.querySelector<HTMLElement>(`[data-tour="${step.anchor ?? step.id}"]`)?.scrollIntoView({ block: "nearest" });
      if (measure() || performance.now() - t0 > SEARCH_MS) {
        if (!findTarget(step.anchor ?? step.id) && OPTIONAL.has(step.id)) {  // not on this page after all (no drains, no rain area)
          if (dir.current > 0 && i < STEPS.length - 1) { setI(i + 1); return; }
          if (dir.current < 0 && i > 0) { setI(i - 1); return; }
        }
        setSearching(false);
        return;
      }
      raf = requestAnimationFrame(look);
    };
    raf = requestAnimationFrame(look);
    return () => cancelAnimationFrame(raf);
  }, [step, measure, i, STEPS.length]);
  const layout = useCallback(() => {
    if (narrow) return layoutNarrow();
    const via = VIA[step.id];
    if (via && !document.querySelector(`[data-tour="${step.id}"]`)) {
      document.querySelector<HTMLElement>(`[data-tour="${via}"]`)?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => { const t2 = findTarget(step.id); setTarget(t2); setPos(place(t2, cardRef.current?.offsetHeight ?? 190)); }));
    }
    // A card low in the sidebar (Drainage, the Simulate bar) scrolls into view before it is measured.
    document.querySelector<HTMLElement>(`[data-tour="${step.id}"]`)?.scrollIntoView({ block: "nearest" });
    const t = findTarget(step.id);
    setTarget(t);
    setPos(place(t, cardRef.current?.offsetHeight ?? 190));
  }, [step.id]);

  useLayoutEffect(() => layout(), [layout]);
  useEffect(() => {
    const again = () => { if (narrow) measure(); else layout(); };
    window.addEventListener("resize", again);
    return () => window.removeEventListener("resize", again);
  }, [measure, layout, narrow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && (e.target as Element | null)?.closest('[role="slider"], [role="switch"], input, textarea, [role="spinbutton"]')) return;
      if (e.key === "Escape") { e.preventDefault(); finish(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [finish, next, back]);

  const scrim = "color-mix(in srgb, var(--ground) 72%, transparent)";
  // Phone and tablet: 40 px buttons (fingers).
  const bh = narrow ? 40 : 30;
  const textBtn = { padding: "3px 6px", ...(narrow ? { minHeight: 40 } : {}), background: "transparent", border: 0, borderRadius: "var(--radius-md)", color: "var(--ink-muted)", font: "inherit", fontSize: 12, fontWeight: 500 } as const;
  const raisedBtn = { height: bh, padding: "0 12px", background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", font: "inherit", fontWeight: 500 } as const;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000 }}>
      {target ? (
        <div aria-hidden="true" style={{ position: "fixed", left: target.left - PAD, top: target.top - PAD, width: target.width + PAD * 2, height: target.height + PAD * 2,
          borderRadius: 6, boxShadow: `0 0 0 9999px ${scrim}`, outline: "var(--stroke-focus) solid var(--danfo)", outlineOffset: 0, pointerEvents: "none" }} />
      ) : (
        <div aria-hidden="true" style={{ position: "fixed", inset: 0, background: scrim }} />
      )}
      <section ref={cardRef} role="dialog" aria-label={`Quick tour, step ${i + 1} of ${STEPS.length}`}
        style={{ position: "fixed", left: pos.left, top: pos.top, width: CARD_W, display: "flex", flexDirection: "column", background: "var(--surface)", visibility: searching ? "hidden" : undefined,
          border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: "var(--shadow-float)", overflow: "hidden" }}>
        <Band title={`Step ${i + 1} of ${STEPS.length}`} right={
          <Button variant="icon" type="button" aria-label="Close tour" onClick={finish}
            style={{ marginLeft: "auto", width: narrow ? 40 : 24, height: narrow ? 40 : 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: 0, color: "var(--ink-muted)" }}>
            <X size={14} weight="bold" />
          </Button>} />
        <div style={{ padding: "12px 14px 4px" }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: 14, lineHeight: "20px" }}>{step.title}</p>
          <p style={{ margin: "4px 0 0", color: "var(--ink-muted)", fontSize: 13, lineHeight: "18px" }}>{step.body}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 12px" }}>
          <Button variant="text" type="button" onClick={finish} style={textBtn}>Skip tour</Button>
          <span style={{ marginLeft: "auto" }} />
          {i > 0 && <Button variant="raised" type="button" onClick={back} style={raisedBtn}>Back</Button>}
          <Button variant="danfo" type="button" autoFocus onClick={next}
            style={{ height: bh, padding: "0 16px", background: "linear-gradient(180deg, color-mix(in srgb, var(--danfo) 88%, white) 0%, var(--danfo) 100%)", color: "var(--on-danfo)",
              border: "1px solid var(--danfo-edge)", borderRadius: "var(--radius-md)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 1px 2px var(--elev-drop), 0 2px 6px var(--elev-drop-soft)", font: "inherit", fontWeight: 600 }}>
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </section>
    </div>
  );
}
