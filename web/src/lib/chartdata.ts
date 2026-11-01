// The ⋮ actions on a chart: the rows behind its table and CSV, the CSV text, the PNG's file name and the CSS variables
// its SVG needs inlined. Pure, so the DOM work stays in the components.

export type ChartTable = { header: string[]; rows: string[][] };

/** One row per frame: the time, then run A when it is compared, then the chart's own series, to `digits` decimals. */
export function chartTable({ title, unit, times, series, ghost, digits, time }: {
  title: string; unit: string; times: number[]; series: number[]; ghost?: number[]; digits: number; time: (s: number) => string;
}): ChartTable {
  const num = (v: number | undefined) => (v != null && Number.isFinite(v) ? v.toFixed(digits) : "");
  const compared = !!ghost && ghost.length > 1;
  const header = compared ? ["Time", `A (${unit})`, `B (${unit})`] : ["Time", `${title} (${unit})`];
  const rows = series.map((v, i) => (compared
    ? [time(times[i]), num(ghost?.[i]), num(v)]
    : [time(times[i]), num(v)]));
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

/** `dryrun-<area>-<chart>-<run or baseline>.png`. */
export function chartFilename(aoi: string, chart: string, run?: string): string {
  return `dryrun-${slug(aoi)}-${slug(chart)}-${run ? slug(run) : "baseline"}.png`;
}

/** Replaces each var(--name) (with an optional fallback) by lookup(name); nested ones resolve on the next pass. */
export function resolveVars(text: string, lookup: (name: string) => string): string {
  let out = text;
  for (let k = 0; k < 4 && out.includes("var("); k++) {
    out = out.replace(/var\((--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name: string, fallback?: string) => lookup(name) || fallback?.trim() || "none");
  }
  return out;
}
