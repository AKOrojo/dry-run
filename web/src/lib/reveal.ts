type Scrollable = { scrollIntoView(o: ScrollIntoViewOptions): void; closest(sel: string): Scrollable | null };

/** Scroll the element matching `sel` under `root` (or, with `card`, the card section around it) just into view. */
export function revealIn(root: { querySelector(sel: string): Scrollable | null } | null | undefined, sel: string,
  card: boolean, reduced: boolean): boolean {
  const el = root?.querySelector(sel);
  const target = card ? el?.closest("section") : el;
  target?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  return !!target;
}
