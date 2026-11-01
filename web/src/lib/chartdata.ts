// The ⋮ actions on a chart: the rows behind its table and CSV, the CSV text, the PNG's file name and the CSS variables
// its SVG needs inlined. Pure, so the DOM work stays in the components.

/** The time column says its format, so a pasted CSV reads on its own. */
export const TIME = "Time (T+hh:mm)";

export type ChartTable = { header: string[]; rows: string[][] };

/** One row per frame: the time, then run A when it is compared, then the chart's own series, to `digits` decimals. */
export function chartTable({ title, unit, times, series, ghost, digits, time }: {
  title: string; unit: string; times: number[]; series: number[]; ghost?: number[]; digits: number; time: (s: number) => string;
}): ChartTable {
  const num = (v: number | undefined) => (v != null && Number.isFinite(v) ? v.toFixed(digits) : "");
  const at = (i: number) => (times[i] != null ? time(times[i]) : "");
  const compared = !!ghost && ghost.length > 1;
  const header = compared ? [TIME, `A (${unit})`, `B (${unit})`] : [TIME, `${title} (${unit})`];
  const rows = series.map((v, i) => (compared
    ? [at(i), num(ghost?.[i]), num(v)]
    : [at(i), num(v)]));
  return { header, rows };
}

/** A CSV cell: quoted when it holds a comma, a quote or a line break, with quotes doubled. */
export const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The table as CSV: header row first, `\n` line ends. */
export function chartCsv(t: ChartTable): string {
  return [t.header, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

/** Lower case, anything that is not a letter or digit becomes one dash, no dashes at the ends. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** `dryrun-<area>-<chart>-<run or baseline>.png`; the run id is kept as it is (only unsafe characters become dashes). */
export function chartFilename(aoi: string, chart: string, run?: string): string {
  return `dryrun-${slug(aoi)}-${slug(chart)}-${run ? run.replace(/[^\w-]+/g, "-") : "baseline"}.png`;
}

/** Replaces each var(--name) (with an optional fallback) by lookup(name); nested ones resolve on the next pass. */
export function resolveVars(text: string, lookup: (name: string) => string): string {
  let out = text;
  for (let k = 0; k < 4 && out.includes("var("); k++) {
    out = out.replace(/var\((--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name: string, fallback?: string) => lookup(name) || fallback?.trim() || "none");
  }
  return out;
}

/** Whether a @font-face unicode-range (e.g. "U+0000-00FF,U+0131") covers any character of `text`; no range covers all. */
export function coversText(range: string, text: string): boolean {
  if (!range.trim()) return true;
  const spans = range.split(",").map((r) => {
    const [a, b] = r.trim().replace(/^U\+/i, "").split("-");
    const lo = parseInt(a.replace(/\?/g, "0"), 16), hi = b ? parseInt(b, 16) : parseInt(a.replace(/\?/g, "F"), 16);
    return [lo, hi] as const;
  });
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (spans.some(([lo, hi]) => c >= lo && c <= hi)) return true;
  }
  return false;
}
