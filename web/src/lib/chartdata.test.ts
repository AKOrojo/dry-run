import { describe, expect, it } from "vitest";
import { chartCsv, chartFilename, chartTable, csvCell, resolveVars, slug } from "./chartdata";

const time = (s: number) => `T+${String(s / 3600).padStart(2, "0")}:00`;

describe("chartTable", () => {
  it("has one row per frame with the time, the value to the chart's decimals and the unit in the header", () => {
    const t = chartTable({ title: "Flooded area", unit: "km²", times: [0, 3600], series: [0, 1.2345], digits: 2, time });
    expect(t.header).toEqual(["Time", "Flooded area (km²)"]);
    expect(t.rows).toEqual([["T+00:00", "0.00"], ["T+01:00", "1.23"]]);
  });

  it("adds A and B columns when run A is drawn under the chart", () => {
    const t = chartTable({ title: "Flooded area", unit: "km²", times: [0, 3600], series: [0, 3], ghost: [0, 9], digits: 1, time });
    expect(t.header).toEqual(["Time", "A (km²)", "B (km²)"]);
    expect(t.rows).toEqual([["T+00:00", "0.0", "0.0"], ["T+01:00", "9.0", "3.0"]]);
  });

  it("ignores a run A with fewer than two points, and leaves gaps empty", () => {
    const solo = chartTable({ title: "Depth", unit: "m", times: [0, 3600], series: [1, NaN], ghost: [5], digits: 0, time });
    expect(solo.header).toEqual(["Time", "Depth (m)"]);
    expect(solo.rows).toEqual([["T+00:00", "1"], ["T+01:00", ""]]);
  });
});

describe("chartCsv", () => {
  it("writes the header first, comma separated, with \\n line ends", () => {
    const csv = chartCsv({ header: ["Time", "Flooded area (km²)"], rows: [["T+00:00", "0.00"], ["T+01:00", "1.20"]] });
    expect(csv).toBe("Time,Flooded area (km²)\nT+00:00,0.00\nT+01:00,1.20");
  });

  it("quotes header text with commas and doubles quotes", () => {
    const csv = chartCsv({ header: ["Time", 'Water, "in" box (m³)'], rows: [["T+00:00", "2"]] });
    expect(csv.split("\n")[0]).toBe('Time,"Water, ""in"" box (m³)"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });
});

describe("chartFilename", () => {
  it("names the area, the chart slug and the run id", () => {
    expect(chartFilename("lagos-lekki-v3", "Drain network running full", "r_cf97d373df9a960d")).toBe("dryrun-lagos-lekki-v3-drain-network-running-full-r_cf97d373df9a960d.png");
  });

  it("says baseline when there is no run", () => {
    expect(chartFilename("lagos-lekki-v3", "Roads impassable")).toBe("dryrun-lagos-lekki-v3-roads-impassable-baseline.png");
  });

  it("slugs awkward characters into single dashes", () => {
    expect(slug("  Fastest flow (m/s)! ")).toBe("fastest-flow-m-s");
  });
});

describe("resolveVars", () => {
  const vars: Record<string, string> = { "--ink": "#111", "--ground": "#fafafa", "--alias": "var(--ink)" };
  const lookup = (n: string) => vars[n] ?? "";

  it("inlines each variable and keeps the rest of the markup", () => {
    expect(resolveVars('<rect fill="var(--ground)" x="1"/>', lookup)).toBe('<rect fill="#fafafa" x="1"/>');
  });

  it("resolves nested variables and falls back when a variable is unknown", () => {
    expect(resolveVars("var(--alias)", lookup)).toBe("#111");
    expect(resolveVars("var(--missing, 10.5px)", lookup)).toBe("10.5px");
    expect(resolveVars("var(--missing)", lookup)).toBe("none");
  });
});
