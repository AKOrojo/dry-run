// Select (design board 11): a button with role=combobox and a listbox popover in a portal above the map. Replaces the
// native <select>. Two looks: "header" (the area picker in the top bar) and "field" (a 32 px box like NumberField).
// Keys: Down/Enter/Space open; Up/Down move; Home/End; typeahead (500 ms buffer); Enter picks; Esc closes without
// picking and never reaches the map; Tab closes and moves on. Focus stays on the trigger (aria-activedescendant).
// Under 600 px it opens as a bottom sheet with a scrim and a drag handle.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import { TipBubble, TOOLTIP_DELAY_MS } from "./Tooltip";

export type SelectOption = { value: string; label: string; detail?: string; detailMono?: boolean };
export type SelectGroup = { caption?: string; options: SelectOption[] };

type Props = {
  /** The accessible name ("Area", "Place", "Run A"). */
  label: string;
  value: string | null | undefined;
  onChange: (value: string) => void;
  options?: SelectOption[];
  groups?: SelectGroup[];
  variant?: "header" | "field";
  placeholder?: string;
  disabled?: boolean;
  /** Called when the list opens (e.g. to fetch second lines). */
  onOpen?: () => void;
  tour?: string;
};

const TYPEAHEAD_MS = 500, MAX_ROWS = 8, MAX_W = 360, SHEET_BELOW_PX = 600, EDGE = 8;

// Keys on a focused Select go to it before anything else on the page: the map, close-up, GPU box and tour listen on
// window in the capture phase, so this listener is installed when the module loads, ahead of theirs.
let focusedKeys: ((e: KeyboardEvent) => boolean) | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (focusedKeys?.(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

const caption: CSSProperties = { fontSize: 11, lineHeight: "14px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
  color: "var(--ink-muted)", padding: "8px 10px 4px" };
const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
/** The area list, and every list on a phone: a long name wraps to a second line, then ends in an ellipsis. */
const twoLines: CSSProperties = { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "normal" };

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

export function Select({ label, value, onChange, options, groups, variant = "field", placeholder, disabled = false, onOpen, tour }: Props) {
  const base = useId();
  const listId = `${base}-list`;
  const all = useMemo<SelectGroup[]>(() => groups ?? [{ options: options ?? [] }], [groups, options]);
  const flat = useMemo(() => all.flatMap((g) => g.options), [all]);
  const selected = flat.findIndex((o) => o.value === value);
  const current = selected >= 0 ? flat[selected] : null;

  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [hover, setHover] = useState(false);
  const [ring, setRing] = useState(false);  // keyboard focus (focus-visible)
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [above, setAbove] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [drag, setDrag] = useState(0);
  const sheet = useMedia(`(max-width: ${SHEET_BELOW_PX - 1}px)`);
  const touch = useMedia("(pointer: coarse)");
  const typed = useRef({ buf: "", at: 0 });
  const tipTimer = useRef<ReturnType<typeof setTimeout>>();

  const optId = (i: number) => `${base}-opt-${i}`;
  const rowH = (o: SelectOption) => (sheet ? 52 : o.detail || touch ? 44 : 32);

  const show = () => {
    if (disabled || !flat.length) return;
    setRect(trigger.current?.getBoundingClientRect() ?? null);
    setActive(selected >= 0 ? selected : 0);
    setOpen(true);
    onOpen?.();
  };
  const close = () => { setOpen(false); setTip(null); setDrag(0); clearTimeout(tipTimer.current); };
  const pick = (i: number) => {
    const o = flat[i];
    close();
    trigger.current?.focus();
    if (o && o.value !== value) onChange(o.value);
  };

  /** Typeahead: the next row whose label starts with what was typed in the last 500 ms (repeating one letter cycles). */
  const seek = (key: string, from: number) => {
    const now = Date.now(), t = typed.current;
    t.buf = now - t.at > TYPEAHEAD_MS ? key.toLowerCase() : t.buf + key.toLowerCase();
    t.at = now;
    const q = /^(.)\1+$/.test(t.buf) ? t.buf[0] : t.buf;
    const start = q.length === 1 ? from + 1 : Math.max(from, 0);
    for (let k = 0; k < flat.length; k++) {
      const i = (start + k) % flat.length;
      if (flat[i].label.toLowerCase().startsWith(q)) return i;
    }
    return -1;
  };

  // Keys while the trigger has focus (see focusedKeys above). Returns true when the key was used.
  const keyClick = useRef(false);  // Enter/Space were handled here: ignore the button's own click that follows
  const keysRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  keysRef.current = (e) => {
    if (disabled) return false;
    if (!open) {
      // Closed: Down/Up/Enter/Space open. Typing in a field picks the matching row straight away (as a native select
      // does); in the header (the area picker, where a change rebuilds the map) it opens the list on that row and Enter
      // commits.
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { keyClick.current = e.key === "Enter" || e.key === " "; show(); return true; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const i = seek(e.key, selected);
        if (variant === "header") { show(); if (i >= 0) setActive(i); }
        else if (i >= 0 && flat[i].value !== value) onChange(flat[i].value);
        return true;
      }
      return false;
    }
    if (e.key === "Enter" || e.key === " ") keyClick.current = true;
    if (e.altKey && e.key === "ArrowUp") { pick(active); return true; }
    switch (e.key) {
      case "ArrowDown": setActive((a) => Math.min(flat.length - 1, a + 1)); return true;
      case "ArrowUp": setActive((a) => Math.max(0, a - 1)); return true;
      case "Home": case "PageUp": setActive(0); return true;
      case "End": case "PageDown": setActive(flat.length - 1); return true;
      case "Enter": pick(active); return true;
      case " ": if (Date.now() - typed.current.at < TYPEAHEAD_MS) { const i = seek(" ", active); if (i >= 0) setActive(i); } else pick(active); return true;
      case "Escape": close(); trigger.current?.focus(); return true;
      case "Tab": close(); return false;  // focus moves on as usual
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { const i = seek(e.key, active); if (i >= 0) setActive(i); return true; }
    return false;
  };
  const mine = useRef((e: KeyboardEvent) => keysRef.current(e)).current;
  useEffect(() => () => { if (focusedKeys === mine) focusedKeys = null; }, [mine]);

  // Outside click closes; the list follows the trigger on scroll and resize.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !pop.current?.contains(t)) close();
    };
    const move = () => setRect(trigger.current?.getBoundingClientRect() ?? null);
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("resize", move);
    window.addEventListener("scroll", move, true);
    return () => { document.removeEventListener("pointerdown", down, true); window.removeEventListener("resize", move); window.removeEventListener("scroll", move, true); };
  }, [open]);

  // Opens below; flips above near the bottom edge; shifts left when it is wider than the room to the right.
  useLayoutEffect(() => {
    if (!open || sheet || !rect || !pop.current) return;
    const h = pop.current.offsetHeight, w = pop.current.offsetWidth, below = window.innerHeight - rect.bottom - EDGE, up = rect.top - EDGE;
    setAbove(h > below && up > below);
    setLeft(Math.max(EDGE, Math.min(rect.left, document.documentElement.clientWidth - EDGE - w)));
  }, [open, sheet, rect, flat.length]);

  // The active row stays in view; when its name is cut off, the full name shows in a Tooltip.
  useEffect(() => {
    if (!open || active < 0) return;
    const row = document.getElementById(optId(active));
    row?.scrollIntoView({ block: "nearest" });
    const name = row?.querySelector<HTMLElement>("[data-name]");
    setTip(name && name.scrollWidth > name.clientWidth && !sheet ? { text: flat[active].label, rect: row!.getBoundingClientRect() } : null);
  }, [open, active]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(tipTimer.current), []);

  const hoverTip = (el: HTMLElement | null, text: string) => {
    clearTimeout(tipTimer.current);
    const name = el?.querySelector<HTMLElement>("[data-name]") ?? el;
    if (!el || !name || (name.scrollWidth <= name.clientWidth && name.scrollHeight <= name.clientHeight + 1)) return;
    tipTimer.current = setTimeout(() => setTip({ text, rect: el.getBoundingClientRect() }), TOOLTIP_DELAY_MS);
  };

  const header = variant === "header";
  const lit = hover || open;
  const triggerStyle: CSSProperties = header
    ? { display: "inline-flex", alignItems: "center", gap: 8, height: 36, minWidth: 120, flex: "0 1 auto", padding: "0 10px", border: 0, borderRadius: "var(--radius-md)",
        font: "inherit", fontSize: 14, fontWeight: 600, color: "var(--ink)", cursor: disabled ? "default" : "pointer",
        background: lit ? "var(--raised-bg)" : "transparent", boxShadow: lit ? "var(--raised-shadow)" : "none" }
    : { display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0, height: 32, padding: "0 8px 0 10px", background: "var(--ground)",
        border: `1px solid ${lit && !disabled ? "var(--ink-muted)" : "var(--control-edge)"}`, borderRadius: "var(--radius-md)",
        boxShadow: "inset 0 1px 2px var(--elev-drop-soft)", font: "inherit", color: "var(--ink)", textAlign: "left", cursor: disabled ? "default" : "pointer" };
  // More than MAX_ROWS rows scroll inside the list (padding 4 + border 1 on each side).
  const maxH = flat.length > MAX_ROWS ? MAX_ROWS * (rowH(flat[0]) + 1) + 10 + all.filter((g) => g.caption).length * 26 : Infinity;

  let n = -1;
  const list = (
    <div ref={pop} role="listbox" id={listId} aria-label={label}
      onMouseDown={(e) => e.preventDefault()}  // keep focus on the trigger
      style={sheet
        ? { position: "fixed", zIndex: 1001, left: 0, right: 0, bottom: 0, maxHeight: "70vh", overflowY: "auto", background: "var(--surface-raised)",
            borderTop: "1px solid var(--hairline)", borderRadius: "12px 12px 0 0", boxShadow: "inset 0 1px 0 var(--elev-hi), var(--shadow-float)",
            padding: "0 4px calc(4px + env(safe-area-inset-bottom))", transform: drag ? `translateY(${drag}px)` : undefined, transition: drag ? "none" : "transform 0.15s" }
        : { position: "fixed", zIndex: 1001, left: left ?? rect?.left ?? 0,
            ...(above && rect ? { bottom: window.innerHeight - rect.top + 4 } : { top: (rect?.bottom ?? 0) + 4 }),
            minWidth: rect?.width, maxWidth: Math.min(MAX_W, document.documentElement.clientWidth - 2 * EDGE), maxHeight: Math.min(maxH, window.innerHeight - 2 * EDGE), overflowY: "auto",
            background: "var(--surface-raised)", border: "1px solid var(--hairline)", borderRadius: 6, boxShadow: "inset 0 1px 0 var(--elev-hi), var(--shadow-float)",
            padding: 4, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 1, fontFamily: "var(--font-sans)", fontSize: 13, lineHeight: "18px", color: "var(--ink)" }}>
      {sheet && (
        <div aria-hidden="true" style={{ position: "sticky", top: 0, display: "flex", justifyContent: "center", padding: "10px 0 6px", background: "var(--surface-raised)", touchAction: "none", cursor: "grab" }}
          onPointerDown={(e) => {
            const y0 = e.clientY, el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const mv = (ev: PointerEvent) => setDrag(Math.max(0, ev.clientY - y0));
            const up = (ev: PointerEvent) => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); if (ev.clientY - y0 > 80) { close(); trigger.current?.focus(); } else setDrag(0); };
            el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
          }}>
          <span style={{ width: 36, height: 4, borderRadius: 2, background: "var(--hairline)" }} />
        </div>
      )}
      {all.map((g, gi) => (
        <div key={gi} role="group" aria-label={g.caption} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {gi > 0 && <div role="separator" style={{ height: 1, margin: "4px 6px", background: "var(--hairline)" }} />}
          {g.caption && <div style={caption}>{g.caption}</div>}
          {g.options.map((o) => {
            const i = ++n, on = i === active, sel = i === selected;
            return (
              <div key={o.value} id={optId(i)} role="option" aria-selected={sel}
                onClick={() => pick(i)} onMouseMove={() => { if (active !== i) setActive(i); }}
                onPointerEnter={(e) => { if (e.pointerType !== "touch") hoverTip(e.currentTarget, o.label); }}
                onPointerLeave={() => clearTimeout(tipTimer.current)}
                style={{ display: "flex", alignItems: "center", gap: 10, minHeight: rowH(o), padding: header || sheet ? "4px 10px" : "0 10px", borderRadius: 4, cursor: "pointer", flex: "none",
                  background: on ? "color-mix(in srgb, var(--ink) 9%, transparent)" : undefined }}>
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span data-name="" style={{ ...(header || sheet ? twoLines : ellipsis), fontWeight: sel ? 600 : 400 }}>{o.label}</span>
                  {o.detail && <span style={{ ...ellipsis, fontSize: 12, lineHeight: "16px", color: "var(--ink-muted)", ...(o.detailMono ? { fontFamily: "var(--font-mono)" } : {}) }}>{o.detail}</span>}
                </span>
                {sel ? <Check size={14} weight="bold" color="var(--ink)" aria-hidden="true" style={{ marginLeft: "auto", flex: "none" }} />
                  : <span style={{ width: 14, flex: "none", marginLeft: "auto" }} />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );

  return (
    <>
      <button ref={trigger} type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optId(active) : undefined} aria-disabled={disabled || undefined} data-tour={tour}
        onClick={() => { if (keyClick.current) { keyClick.current = false; return; } if (open) { close(); trigger.current?.focus(); } else show(); }}
        onKeyUp={() => setTimeout(() => { keyClick.current = false; })}
        onPointerEnter={(e) => { setHover(true); if (e.pointerType !== "touch" && current) hoverTip(e.currentTarget, current.label); }}
        onPointerLeave={() => { setHover(false); clearTimeout(tipTimer.current); if (!open) setTip(null); }}
        onFocus={(e) => { focusedKeys = mine; setRing(e.currentTarget.matches(":focus-visible")); }}
        onBlur={() => { if (focusedKeys === mine) focusedKeys = null; setRing(false); keyClick.current = false; if (open) close(); }}
        style={{ ...triggerStyle, opacity: disabled ? 0.45 : 1, outline: ring ? "2px solid var(--focus-ring)" : "none", outlineOffset: 2 }}>
        <span data-name="" style={{ ...ellipsis, ...(header ? {} : { flex: 1, minWidth: 0 }), ...(current ? { fontWeight: 600 } : { color: "var(--ink-muted)", fontWeight: 400 }) }}>
          {current?.label ?? placeholder ?? ""}
        </span>
        <CaretDown size={14} weight="bold" color="var(--ink-muted)" aria-hidden="true" style={{ flex: "none", transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open && createPortal(<>
        {sheet && <div aria-hidden="true" onClick={() => { close(); trigger.current?.focus(); }}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "color-mix(in srgb, var(--ground) 60%, transparent)" }} />}
        {list}
      </>, document.body)}
      {tip && <TipBubble text={tip.text} anchor={tip.rect} />}
    </>
  );
}
