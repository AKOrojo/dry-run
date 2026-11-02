// Menu (design board 11): one popover for the header's View and Share, the chart kebab, the draw-route menu and the map's
// right-click menu. Same popover and bottom sheet as Select: it flips above near the bottom edge, is at least the trigger's
// width and at most 360 px; under 600 px it is a bottom sheet with a scrim over the map and a drag handle. Items are
// menuitem, menuitemcheckbox or menuitemradio; focus moves between them (roving focus). Keys: Up/Down (wrapping), Home/End,
// typeahead (500 ms buffer), Enter/Space run, Esc closes and returns focus, Tab closes and moves on. Esc never reaches the
// map or the tour while a menu is open. Opened from a trigger button, or at a point (`at`, controlled) for the map.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { Check } from "@phosphor-icons/react";
import { hideTooltips } from "./Tooltip";
import { fingerDown, liftGuard, trackPointers } from "../../lib/liftGuard";
import type { LiftGuard } from "../../lib/liftGuard";

export type MenuItem = {
  kind: "item" | "check" | "radio";
  label: string;
  /** Leading 16 px icon, muted. A toggle without an icon shows a check when on. */
  icon?: ReactNode;
  /** Trailing hint in muted 12 px. */
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** Stays open after the pick (the View toggles). */
  keepOpen?: boolean;
  /** Why the item is disabled: a second muted 12 px line, which the item describes itself with. */
  reason?: string;
};
export type MenuEntry = MenuItem | { kind: "separator" } | { kind: "caption"; label: string };

export type MenuTriggerProps = {
  ref: RefObject<HTMLButtonElement>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  onKeyUp: () => void;
  onFocus: () => void;
  onBlur: () => void;
};

type Props = {
  /** The popover's accessible name. */
  label: string;
  /** The trigger button; spread the props it receives. Omit it for the controlled point mode. */
  trigger?: (props: MenuTriggerProps) => ReactElement;
  items: MenuEntry[];
  /** Point mode (the map's right-click menu): the viewport point to open at, or null when closed. */
  at?: { x: number; y: number } | null;
  onClose?: () => void;
  /** Where focus goes when the menu closes (default: the trigger). */
  returnFocus?: () => HTMLElement | null | undefined;
};

type Anchor = { left: number; top: number; bottom: number; width: number };
type KeyLike = Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">;
type KeyFn = (e: KeyboardEvent) => boolean;

const TYPEAHEAD_MS = 500, MIN_W = 220, MAX_W = 360, SHEET_BELOW_PX = 600, EDGE = 8;

/** Only one menu is open at a time; its keys go to it before anything else on the page (the map, the tour and the
 *  close-up listen on window in the capture phase). The listener is installed when the module loads, ahead of theirs. */
let menuKeys: KeyFn | null = null;
let focusedKeys: KeyFn | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if ((menuKeys ?? focusedKeys)?.(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

// Disabled items are reached too (WAI-ARIA: aria-disabled, not removed from focus); activating one does nothing.
const isNav = (it: MenuEntry): it is MenuItem => it.kind !== "separator" && it.kind !== "caption";

/** The index the key moves to from `current` (-1 when nothing is active), skipping separators and captions.
 *  Down and Up wrap; Home and End go to the first and last item. -1 when there is nothing to move to. */
export function nextIndex(key: string, current: number, items: MenuEntry[]): number {
  const n = items.length;
  const nav = items.flatMap((it, i) => (isNav(it) ? [i] : []));
  if (!nav.length) return -1;
  if (key === "Home") return nav[0];
  if (key === "End") return nav[nav.length - 1];
  if (key !== "ArrowDown" && key !== "ArrowUp") return -1;
  const down = key === "ArrowDown";
  if (current < 0) return down ? nav[0] : nav[nav.length - 1];
  for (let k = 1; k <= n; k++) {
    const i = (((current + (down ? k : -k)) % n) + n) % n;
    if (isNav(items[i])) return i;
  }
  return -1;
}

/** The next item whose label starts with `buf` (lower case), searching from the row after `from`. A buffer of one
 *  repeated letter ("aaa") cycles through the items that start with that letter. -1 when none matches. */
export function typeahead(buf: string, items: MenuEntry[], from: number): number {
  const q = /^(.)\1+$/.test(buf) ? buf[0] : buf;
  if (!q) return -1;
  const n = items.length;
  const start = q.length === 1 ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    const it = items[i];
    if (isNav(it) && it.label.toLowerCase().startsWith(q)) return i;
  }
  return -1;
}

const useMedia = (q: string) => {
  const [on, setOn] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [q]);
  return on;
};

const caption: CSSProperties = { fontSize: 11, lineHeight: "14px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
  color: "var(--ink-muted)", padding: "8px 10px 4px" };
const rule: CSSProperties = { height: 1, margin: "4px 6px", background: "var(--hairline)" };

export function Menu({ label, trigger, items, at, onClose, returnFocus }: Props) {
  const base = useId();
  const listId = `${base}-menu`;
  const itemId = (i: number) => `${base}-item-${i}`;
  const reasonId = (i: number) => `${base}-reason-${i}`;
  const controlled = at !== undefined;
  const [openT, setOpenT] = useState(false);
  const [anchorT, setAnchorT] = useState<Anchor | null>(null);
  const [active, setActive] = useState(-1);
  const [above, setAbove] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const [drag, setDrag] = useState(0);
  const sheet = useMedia(`(max-width: ${SHEET_BELOW_PX - 1}px)`);

  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const activeRef = useRef(-1);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const typed = useRef({ buf: "", at: 0 });
  const keyed = useRef(false);  // Enter or Space opened the menu: swallow the button's own click that follows

  const open = controlled ? !!at : openT;
  const anchor: Anchor | null = controlled ? (at ? { left: at.x, top: at.y, bottom: at.y, width: 0 } : null) : anchorT;
  const rowH = sheet ? 52 : 32;

  const move = (i: number) => { activeRef.current = i; setActive(i); };
  const close = (refocus = true) => {
    if (controlled) onClose?.(); else setOpenT(false);
    if (refocus) (returnFocus?.() ?? btn.current)?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  const openWith = (i: number) => {
    setAnchorT(btn.current?.getBoundingClientRect() ?? null);
    move(i);
    setOpenT(true);
  };

  const run = (i: number) => {
    const it = itemsRef.current[i];
    if (!it || !isNav(it) || it.disabled) return;
    if (!it.keepOpen) close();
    it.onSelect();
  };

  // Keys on the open popover (see the module comment).
  const menuKeysRef = useRef<KeyFn>(() => false);
  menuKeysRef.current = (e) => {
    const list = itemsRef.current;
    switch (e.key) {
      case "Escape": close(); return true;
      case "Tab": close(false); return false;  // focus moves on as usual
      case "ArrowDown": case "ArrowUp": case "Home": case "End": {
        const i = nextIndex(e.key, activeRef.current, list);
        if (i >= 0) move(i);
        return true;
      }
      case "Enter": case " ": run(activeRef.current); return true;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      const now = Date.now(), t = typed.current;
      t.buf = now - t.at > TYPEAHEAD_MS ? e.key.toLowerCase() : t.buf + e.key.toLowerCase();
      t.at = now;
      const i = typeahead(t.buf, list, activeRef.current);
      if (i >= 0) move(i);
      return true;
    }
    return false;
  };

  // Keys on the focused trigger: Down, Enter and Space open with the first item active; Up opens with the last.
  const trigRef = useRef<(e: KeyLike) => boolean>(() => false);
  trigRef.current = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return false;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { keyed.current = true; openWith(nextIndex("Home", -1, itemsRef.current)); return true; }
    if (e.key === "ArrowUp") { keyed.current = true; openWith(nextIndex("End", -1, itemsRef.current)); return true; }
    return false;
  };
  const stableTrig = useRef<KeyFn>((e) => trigRef.current(e)).current;
  useEffect(() => () => { if (focusedKeys === stableTrig) focusedKeys = null; }, [stableTrig]);

  // Registers the popover's keys while it is open; the first item takes focus unless a key already chose one.
  useEffect(() => {
    if (!open) { activeRef.current = -1; setActive(-1); return; }
    hideTooltips();
    if (activeRef.current < 0) move(nextIndex("Home", -1, itemsRef.current));
    const f: KeyFn = (e) => menuKeysRef.current(e);
    menuKeys = f;
    return () => { if (menuKeys === f) menuKeys = null; };
  }, [open]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(itemId(active))?.focus();
  }, [open, active]);  // eslint-disable-line react-hooks/exhaustive-deps

  // A menu opened by a long press waits for that finger to lift before outside taps close it, and the lift's own click
  // is swallowed (lib/liftGuard.ts): otherwise it lands on the sheet's backdrop and the menu closes as it opens.
  useEffect(() => { trackPointers(); }, []);
  const guard = useRef<LiftGuard | null>(null);
  const armed = () => guard.current?.armed() ?? true;
  useEffect(() => {
    if (!open) return;
    const g = liftGuard(document, fingerDown);
    guard.current = g;
    return () => { g.dispose(); if (guard.current === g) guard.current = null; };
  }, [open]);

  // Outside click closes; a trigger menu follows its trigger on scroll and resize, a point menu closes on resize.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!armed()) return;
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) closeRef.current(false);
    };
    const place = () => { if (!controlled) setAnchorT(btn.current?.getBoundingClientRect() ?? null); };
    const resize = () => { if (controlled) closeRef.current(false); else place(); };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, controlled]);

  // Opens below the anchor; flips above near the bottom edge; shifts left when it is wider than the room to the right.
  useLayoutEffect(() => {
    if (!open || sheet || !anchor || !pop.current) return;
    const h = pop.current.offsetHeight, w = pop.current.offsetWidth;
    const below = window.innerHeight - anchor.bottom - EDGE, up = anchor.top - EDGE;
    setAbove(h > below && up > below);
    setLeft(Math.max(EDGE, Math.min(anchor.left, document.documentElement.clientWidth - EDGE - w)));
  }, [open, sheet, anchor?.left, anchor?.top, anchor?.bottom, items.length]);  // eslint-disable-line react-hooks/exhaustive-deps

  const list = (
    <div ref={pop} id={listId} role="menu" aria-label={label}
      style={sheet
        ? { position: "fixed", zIndex: 1001, left: 0, right: 0, bottom: 0, maxHeight: "70vh", overflowY: "auto", background: "var(--surface-raised)",
            borderTop: "1px solid var(--hairline)", borderRadius: "12px 12px 0 0", boxShadow: "inset 0 1px 0 var(--elev-hi), var(--shadow-float)",
            padding: "0 4px calc(4px + env(safe-area-inset-bottom))", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 1,
            transform: drag ? `translateY(${drag}px)` : undefined, transition: drag ? "none" : "transform 0.15s", fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--ink)" }
        : { position: "fixed", zIndex: 1001, left: left ?? anchor?.left ?? 0,
            ...(above && anchor ? { bottom: window.innerHeight - anchor.top + 4 } : { top: (anchor?.bottom ?? 0) + 4 }),
            minWidth: Math.max(anchor?.width ?? 0, MIN_W), maxWidth: Math.min(MAX_W, document.documentElement.clientWidth - 2 * EDGE),
            maxHeight: window.innerHeight - 2 * EDGE, overflowY: "auto", background: "var(--surface-raised)", border: "1px solid var(--hairline)", borderRadius: 6,
            boxShadow: "inset 0 1px 0 var(--elev-hi), var(--shadow-float)", padding: 4, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 1,
            fontFamily: "var(--font-sans)", fontSize: 13, lineHeight: "18px", color: "var(--ink)" }}>
      {sheet && (
        <div aria-hidden="true" style={{ position: "sticky", top: 0, display: "flex", justifyContent: "center", padding: "10px 0 6px", background: "var(--surface-raised)", touchAction: "none", cursor: "grab" }}
          onPointerDown={(e) => {
            const y0 = e.clientY, el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const mv = (ev: PointerEvent) => setDrag(Math.max(0, ev.clientY - y0));
            const up = (ev: PointerEvent) => {
              el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up);
              if (ev.clientY - y0 > 80) close(); else setDrag(0);
            };
            el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
          }}>
          <span style={{ width: 36, height: 4, borderRadius: 2, background: "var(--hairline)" }} />
        </div>
      )}
      {items.map((it, i) => {
        if (it.kind === "separator") return <div key={i} role="separator" style={rule} />;
        if (it.kind === "caption") return <div key={i} style={caption}>{it.label}</div>;
        const on = i === active;
        const role = it.kind === "item" ? "menuitem" : it.kind === "check" ? "menuitemcheckbox" : "menuitemradio";
        const lead = it.icon ?? (it.kind !== "item" && it.checked ? <Check size={14} weight="bold" color="var(--ink)" /> : null);
        return (
          <div key={i} id={itemId(i)} role={role} tabIndex={-1}
            aria-checked={it.kind === "item" ? undefined : !!it.checked} aria-disabled={it.disabled || undefined}
            aria-describedby={it.reason ? reasonId(i) : undefined}
            onClick={() => run(i)}
            onMouseMove={() => { if (activeRef.current !== i) move(i); }}
            style={{ display: "flex", alignItems: "center", gap: 10, minHeight: rowH, padding: it.reason ? "6px 10px" : "0 10px", borderRadius: 4, flex: "none", whiteSpace: "nowrap",
              cursor: it.disabled ? "default" : "pointer", color: it.disabled ? "var(--ink-muted)" : "var(--ink)", outline: "none",
              background: on ? "color-mix(in srgb, var(--ink) 9%, transparent)" : undefined }}>
            <span style={{ width: 16, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", color: "var(--ink-muted)" }}>{lead}</span>
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span>{it.label}</span>
              {it.reason && <span id={reasonId(i)} style={{ fontSize: 12, lineHeight: "16px", color: "var(--ink-muted)", whiteSpace: "normal" }}>{it.reason}</span>}
            </span>
            {it.hint && <span style={{ marginLeft: "auto", paddingLeft: 16, fontSize: 12, lineHeight: "16px", color: "var(--ink-muted)" }}>{it.hint}</span>}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {trigger?.({
        ref: btn,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? listId : undefined,
        onClick: () => {
          if (keyed.current) { keyed.current = false; return; }
          if (open) close(false); else openWith(nextIndex("Home", -1, itemsRef.current));
        },
        onKeyDown: (e) => { if (trigRef.current(e)) e.preventDefault(); },
        onKeyUp: () => { setTimeout(() => { keyed.current = false; }); },
        onFocus: () => { focusedKeys = stableTrig; },
        onBlur: () => { if (focusedKeys === stableTrig) focusedKeys = null; keyed.current = false; },
      })}
      {open && createPortal(<>
        {sheet && <div aria-hidden="true" onClick={() => { if (armed()) close(); }}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "color-mix(in srgb, var(--ground) 60%, transparent)" }} />}
        {list}
      </>, document.body)}
    </>
  );
}
