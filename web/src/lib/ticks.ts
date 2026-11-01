// Axis labels that never overlap (board 13): the mini-charts and the Timeline scrubber share one rule.

export type Anchor = "start" | "middle" | "end";

/** At least this many px per label. */
export const TICK_GAP = 56;
/** Under this much plot width only the first and last labels show. */
export const TICK_BARE = 160;
const PAD = 4;

/** A label's width: an upper bound for IBM Plex Sans figures (0.6 em a character), so no font has to load. */
export const labelWidth = (text: string, fontPx: number) => text.length * fontPx * 0.6;

/** Which labels to show: the first and last always, the middle thinned evenly (every k-th) so that labels are at least
 *  TICK_GAP apart and their boxes do not touch. `xs` are label positions in px, ascending; `ws` their widths. The
 *  first label is start-anchored and the last end-anchored unless `anchors` says otherwise. Returns indices. */
export function thinTicks(xs: number[], ws: number[], plotW: number, anchors?: Anchor[]): number[] {
  const n = xs.length;
  if (n <= 2) return xs.map((_, i) => i);
  if (plotW < TICK_BARE) return [0, n - 1];
  const anchor = (i: number): Anchor => anchors?.[i] ?? (i === 0 ? "start" : i === n - 1 ? "end" : "middle");
  const box = (i: number): [number, number] => {
    const a = anchor(i), w = ws[i];
    return a === "start" ? [xs[i], xs[i] + w] : a === "end" ? [xs[i] - w, xs[i]] : [xs[i] - w / 2, xs[i] + w / 2];
  };
  const fits = (a: number, b: number) => xs[b] - xs[a] >= TICK_GAP && box(b)[0] - box(a)[1] >= PAD;
  for (let k = 1; k < n - 1; k++) {
    const pick: number[] = [];
    for (let i = 0; i < n - 1; i += k) pick.push(i);
    // The last label is kept; a middle one too close to it goes.
    while (pick.length > 1 && !fits(pick[pick.length - 1], n - 1)) pick.pop();
    pick.push(n - 1);
    if (pick.every((v, j) => j === 0 || fits(pick[j - 1], v))) return pick;
  }
  return [0, n - 1];
}
