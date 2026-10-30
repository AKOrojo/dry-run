// First-visit quick tour: dim scrim, a ring around the target ([data-tour="<id>"]) and a small card beside it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { Band } from "./rev5";

const DONE_KEY = "dr_tour_done";
const CARD_W = 300;
const GAP = 14;
const PAD = 6;
const MARGIN = 12;

const ALL_STEPS = [
  { id: "scenario", title: "Set up a storm", body: "Choose rain total, duration and pattern, and the lagoon level on coastal areas." },
  { id: "rain", title: "Choose where it rains", body: "Place a storm cell, draw an area or pick a place, and see the rain before you simulate." },
  { id: "simulate", title: "Run the flood model", body: "Simulate runs the storm on the 30 m model and fills the map and timeline." },
  { id: "map", title: "Read the water", body: "Hover for depth at any point. Click to pin it and follow it over time." },
  { id: "camera", title: "Move like a 3D app", body: "Right-drag or Ctrl+drag to orbit, Free to fly with WASD, or draw a route and fly along it." },
  { id: "timeline", title: "Scrub through the storm", body: "Play or drag the timeline. Key events jump to the moment and place they happen." },
  { id: "marks", title: "Mark places and moments", body: "Right-click the map to drop a waypoint; + Note pins a note at the playhead." },
  { id: "layers", title: "Choose the base map", body: "In Layers, switch between Photoreal 3D and Aerial. Aerial uses Bing; judges can switch it to Google with the judge key." },
  { id: "viewshare", title: "Change the view or share it", body: "View hides panels and switches imagery or theme; Share copies a link to this moment or saves the map as an image." },
  { id: "plan", title: "Inspect a building", body: "Switch to the 2D plan view and click a building for its depths and the street beside it." },
  { id: "closeup", title: "See it up close in 3D", body: "Where a 3D close-up exists, open it to see the water surface, flow and the force of water on each building." },
  { id: "compare", title: "Compare two runs", body: "Pick runs A and B, then swipe, set side by side or difference their water on the map." },
  { id: "agent", title: "Ask the planning agent", body: "Give it a goal: it runs scenarios, charts every run against the others and writes a brief you can check." },
] as const;
type Step = (typeof ALL_STEPS)[number];
/** Steps whose anchor is only on the page sometimes (a run with a 3D close-up) are left out when it is not there. */
const OPTIONAL = new Set<string>(["closeup"]);
const stepsOnPage = (): readonly Step[] => ALL_STEPS.filter((st) => !OPTIONAL.has(st.id) || document.querySelector(`[data-tour="${st.id}"]`));

export function tourDone(): boolean {
  try { return localStorage.getItem(DONE_KEY) === "1"; } catch { return false; }
}
function markDone() {
  try { localStorage.setItem(DONE_KEY, "1"); } catch { /* storage unavailable */ }
}
export function tourDisabled(): boolean {
  try { return new URLSearchParams(window.location.search).get("notour") === "1"; } catch { return false; }
}

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

export function Tour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [target, setTarget] = useState<Box | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: MARGIN, top: MARGIN });
  const cardRef = useRef<HTMLElement>(null);
  const [STEPS] = useState(stepsOnPage);
  const last = i === STEPS.length - 1;
  const step = STEPS[i];

  const finish = useCallback(() => { markDone(); onClose(); }, [onClose]);
  const next = useCallback(() => { if (last) finish(); else setI((n) => n + 1); }, [last, finish]);
  const back = useCallback(() => setI((n) => Math.max(0, n - 1)), []);

  const layout = useCallback(() => {
    const t = findTarget(step.id);
    setTarget(t);
    setPos(place(t, cardRef.current?.offsetHeight ?? 190));
  }, [step.id]);

  useLayoutEffect(() => { layout(); }, [layout]);
  useEffect(() => {
    window.addEventListener("resize", layout);
    return () => window.removeEventListener("resize", layout);
  }, [layout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [finish, next, back]);

  const scrim = "color-mix(in srgb, var(--ground) 72%, transparent)";
  const textBtn = { padding: "3px 6px", background: "transparent", border: 0, borderRadius: "var(--radius-md)", color: "var(--ink-muted)", font: "inherit", fontSize: 12, fontWeight: 500 } as const;
  const raisedBtn = { height: 30, padding: "0 12px", background: "var(--raised-bg)", boxShadow: "var(--raised-shadow)", color: "var(--ink)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", font: "inherit", fontWeight: 500 } as const;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000 }}>
      {target ? (
        <div aria-hidden="true" style={{ position: "fixed", left: target.left - PAD, top: target.top - PAD, width: target.width + PAD * 2, height: target.height + PAD * 2,
          borderRadius: 6, boxShadow: `0 0 0 9999px ${scrim}`, outline: "var(--stroke-focus) solid var(--danfo)", outlineOffset: 0, pointerEvents: "none" }} />
      ) : (
        <div aria-hidden="true" style={{ position: "fixed", inset: 0, background: scrim }} />
      )}
      <section ref={cardRef} role="dialog" aria-label={`Quick tour, step ${i + 1} of ${STEPS.length}`}
        style={{ position: "fixed", left: pos.left, top: pos.top, width: CARD_W, display: "flex", flexDirection: "column", background: "var(--surface)",
          border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: "var(--shadow-float)", overflow: "hidden" }}>
        <Band title={`Step ${i + 1} of ${STEPS.length}`} right={
          <button type="button" aria-label="Close tour" onClick={finish}
            style={{ marginLeft: "auto", width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: 0, color: "var(--ink-muted)" }}>
            <X size={14} weight="bold" />
          </button>} />
        <div style={{ padding: "12px 14px 4px" }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: 14, lineHeight: "20px" }}>{step.title}</p>
          <p style={{ margin: "4px 0 0", color: "var(--ink-muted)", fontSize: 13, lineHeight: "18px" }}>{step.body}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 12px" }}>
          <button type="button" onClick={finish} style={textBtn}>Skip tour</button>
          <span style={{ marginLeft: "auto" }} />
          {i > 0 && <button type="button" onClick={back} style={raisedBtn}>Back</button>}
          <button type="button" autoFocus onClick={next}
            style={{ height: 30, padding: "0 16px", background: "linear-gradient(180deg, color-mix(in srgb, var(--danfo) 88%, white) 0%, var(--danfo) 100%)", color: "var(--on-danfo)",
              border: "1px solid var(--danfo-edge)", borderRadius: "var(--radius-md)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 1px 2px var(--elev-drop), 0 2px 6px var(--elev-drop-soft)", font: "inherit", fontWeight: 600 }}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </section>
    </div>
  );
}
