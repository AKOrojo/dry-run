// Tooltip (design board 11): ink on ground, 12/16, at most 240 px, 4 px radius, 8 px arrow. Shows after 500 ms of
// hover or at once on keyboard focus; never on touch. Rendered in a portal so it sits above the map.
import { cloneElement, useEffect, useId, useRef, useState } from "react";
import type { FocusEvent, PointerEvent, ReactElement } from "react";
import { createPortal } from "react-dom";

export const TOOLTIP_DELAY_MS = 500;
const GAP = 8, MARGIN = 8;

/** The bubble itself, placed above `anchor` (below when there is no room), clamped to the window. */
export function TipBubble({ id, text, anchor }: { id?: string; text: string; anchor: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean; arrow: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, cx = anchor.left + anchor.width / 2;
    const below = anchor.top - GAP - h < MARGIN;
    const left = Math.max(MARGIN, Math.min(document.documentElement.clientWidth - MARGIN - w, cx - w / 2));
    setPos({ left, top: below ? anchor.bottom + GAP : anchor.top - GAP - h, below, arrow: Math.max(8, Math.min(w - 8, cx - left)) });
  }, [anchor, text]);
  return createPortal(
    <div ref={ref} id={id} role="tooltip" style={{ position: "fixed", zIndex: 1100, left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxWidth: 240,
      padding: "4px 8px", background: "var(--ink)", color: "var(--ground)", fontSize: 12, lineHeight: "16px", fontWeight: 400, borderRadius: 4,
      pointerEvents: "none", whiteSpace: "normal", overflowWrap: "anywhere", fontFamily: "var(--font-sans)" }}>
      {text}
      {pos && <span aria-hidden="true" style={{ position: "absolute", left: pos.arrow - 4, [pos.below ? "top" : "bottom"]: -4, width: 8, height: 8,
        background: "var(--ink)", transform: "rotate(45deg)" }} />}
    </div>,
    document.body,
  );
}

/** Wraps one focusable element: `<Tooltip text="Full screen · F"><button …/></Tooltip>`. */
export function Tooltip({ text, children }: { text: string; children: ReactElement }) {
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const hide = () => { clearTimeout(timer.current); setAnchor(null); };
  const p = children.props as Record<string, ((e: never) => void) | undefined>;
  const call = (name: string, e: unknown) => (p[name] as ((e: unknown) => void) | undefined)?.(e);
  return (
    <>
      {cloneElement(children, {
        "aria-describedby": anchor ? id : undefined,
        onPointerEnter: (e: PointerEvent<HTMLElement>) => {
          call("onPointerEnter", e);
          if (e.pointerType === "touch") return;
          const el = e.currentTarget;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setAnchor(el.getBoundingClientRect()), TOOLTIP_DELAY_MS);
        },
        onPointerLeave: (e: PointerEvent<HTMLElement>) => { call("onPointerLeave", e); hide(); },
        onPointerDown: (e: PointerEvent<HTMLElement>) => { call("onPointerDown", e); hide(); },
        onFocus: (e: FocusEvent<HTMLElement>) => { call("onFocus", e); if (e.currentTarget.matches(":focus-visible")) setAnchor(e.currentTarget.getBoundingClientRect()); },
        onBlur: (e: FocusEvent<HTMLElement>) => { call("onBlur", e); hide(); },
      })}
      {anchor && <TipBubble id={id} text={text} anchor={anchor} />}
    </>
  );
}
