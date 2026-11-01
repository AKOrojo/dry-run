// Tooltip (design board 11): ink on ground, 12/16, at most 240 px, 4 px radius, 8 px arrow. Shows after 500 ms of
// hover or at once on keyboard focus; never on touch. Rendered in a portal so it sits above the map.
import { cloneElement, useEffect, useId, useRef, useState } from "react";
import type { FocusEvent, PointerEvent, ReactElement } from "react";
import { createPortal } from "react-dom";

export const TOOLTIP_DELAY_MS = 500;
const GAP = 8, MARGIN = 8, HIDE_ALL = "dr-hide-tooltips";

/** Hides every showing tooltip (a menu opening over its trigger calls it). */
export const hideTooltips = () => window.dispatchEvent(new Event(HIDE_ALL));

/** The bubble itself, placed above `anchor` (below when there is no room), clamped to the window. */
export function TipBubble({ id, text, anchor, decorative = false }: { id?: string; text: string; anchor: DOMRect;
  /** The text is already the element's description elsewhere: keep the bubble out of the accessibility tree. */ decorative?: boolean }) {
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
    <div ref={ref} id={id} role="tooltip" aria-hidden={decorative || undefined} style={{ position: "fixed", zIndex: 1100, left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxWidth: 240,
      padding: "4px 8px", background: "var(--ink)", color: "var(--ground)", fontSize: 12, lineHeight: "16px", fontWeight: 400, borderRadius: 4,
      pointerEvents: "none", whiteSpace: "normal", overflowWrap: "anywhere", fontFamily: "var(--font-sans)" }}>
      {text}
      {pos && <span aria-hidden="true" style={{ position: "absolute", left: pos.arrow - 4, [pos.below ? "top" : "bottom"]: -4, width: 8, height: 8,
        background: "var(--ink)", transform: "rotate(45deg)" }} />}
    </div>,
    document.body,
  );
}

// Visually hidden but still read: the text a native title gave as the element's description.
const srOnly = { position: "fixed", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 } as const;

/** The child's own aria-describedby (a field's counter) plus the tooltip's. */
export const describedBy = (own: unknown, id: string) => (typeof own === "string" && own.trim() ? `${own} ${id}` : id);

/** Same as Tooltip, but renders the child bare when there is no text (an optional `title`). */
export function Tip({ text, children }: { text?: string | null; children: ReactElement }) {
  return text ? <Tooltip text={text}>{children}</Tooltip> : children;
}

/** Wraps one focusable element: `<Tooltip text="Full screen · F"><button …/></Tooltip>`. */
export function Tooltip({ text, children }: { text: string; children: ReactElement }) {
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const off = () => { clearTimeout(timer.current); timer.current = undefined; setAnchor(null); };
    window.addEventListener(HIDE_ALL, off);
    return () => window.removeEventListener(HIDE_ALL, off);
  }, []);
  const hide = () => { clearTimeout(timer.current); timer.current = undefined; setAnchor(null); };
  // Escape dismisses a showing tooltip without moving focus or the pointer (WCAG 1.4.13); others still get the key.
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [anchor]);
  const later = (el: HTMLElement) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = undefined; setAnchor(el.getBoundingClientRect()); }, TOOLTIP_DELAY_MS);
  };
  // Over a nested element with its own tooltip (a row's remove button), only the inner one shows, as with native titles.
  const nested = (e: PointerEvent<HTMLElement>) => (e.target as Element).closest("[data-tip]") !== e.currentTarget;
  const p = children.props as Record<string, ((e: never) => void) | undefined>;
  const call = (name: string, e: unknown) => (p[name] as ((e: unknown) => void) | undefined)?.(e);
  return (
    <>
      {cloneElement(children, {
        // Always described, as with a native title, not only while the bubble shows.
        "aria-describedby": describedBy((children.props as { "aria-describedby"?: string })["aria-describedby"], id),
        "data-tip": "",
        onPointerEnter: (e: PointerEvent<HTMLElement>) => {
          call("onPointerEnter", e);
          if (e.pointerType === "touch" || nested(e)) return;
          later(e.currentTarget);
        },
        onPointerOver: (e: PointerEvent<HTMLElement>) => {
          call("onPointerOver", e);
          if (e.pointerType === "touch") return;
          if (nested(e)) hide();
          else if (!anchor && !timer.current) later(e.currentTarget);
        },
        onPointerLeave: (e: PointerEvent<HTMLElement>) => { call("onPointerLeave", e); hide(); },
        onPointerDown: (e: PointerEvent<HTMLElement>) => { call("onPointerDown", e); hide(); },
        onFocus: (e: FocusEvent<HTMLElement>) => { call("onFocus", e); if (e.currentTarget.matches(":focus-visible")) setAnchor(e.currentTarget.getBoundingClientRect()); },
        onBlur: (e: FocusEvent<HTMLElement>) => { call("onBlur", e); hide(); },
      })}
      {createPortal(<span id={id} style={srOnly}>{text}</span>, document.body)}
      {anchor && <TipBubble text={text} anchor={anchor} decorative />}
    </>
  );
}
