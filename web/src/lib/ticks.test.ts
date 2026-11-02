import { describe, expect, it } from "vitest";
import { labelWidth, thinTicks, TICK_GAP } from "./ticks";

const hours = (n: number, plotW: number, x0 = 0) => Array.from({ length: n + 1 }, (_, h) => x0 + (plotW * h) / n);
const widths = (n: number) => Array.from({ length: n + 1 }, () => labelWidth("T+00:00", 10.5));

describe("thinTicks", () => {
  it("keeps every label when there is room", () => {
    expect(thinTicks(hours(6, 700), widths(6), 700)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("thins the middle evenly and keeps the ends", () => {
    expect(thinTicks(hours(6, 370), widths(6), 370)).toEqual([0, 2, 4, 6]);
    expect(thinTicks(hours(6, 200), widths(6), 200)).toEqual([0, 3, 6]);
  });

  it("shows only the ends under 160 px", () => {
    expect(thinTicks(hours(6, 159), widths(6), 159)).toEqual([0, 6]);
    expect(thinTicks(hours(12, 100), widths(12), 100)).toEqual([0, 12]);
  });

  it("never lets labels overlap or come closer than the gap, at any width", () => {
    for (let w = 160; w <= 1200; w += 7) {
      for (const n of [1, 2, 3, 6, 12, 24]) {
        const xs = hours(n, w), ws = widths(n), pick = thinTicks(xs, ws, w);
        expect(pick[0]).toBe(0);
        expect(pick[pick.length - 1]).toBe(n);
        if (n < 2) continue;
        // Only the two ends may sit closer (they always show); any middle label keeps the gap and a clear box.
        if (pick.length > 2) for (let j = 1; j < pick.length; j++) expect(xs[pick[j]] - xs[pick[j - 1]]).toBeGreaterThanOrEqual(TICK_GAP);
        const box = (i: number) => (i === 0 ? [xs[i], xs[i] + ws[i]] : i === n ? [xs[i] - ws[i], xs[i]] : [xs[i] - ws[i] / 2, xs[i] + ws[i] / 2]);
        if (pick.length > 2) for (let j = 1; j < pick.length; j++) expect(box(pick[j])[0]).toBeGreaterThan(box(pick[j - 1])[1]);
      }
    }
  });

  it("honours a middle-anchored last label (a run that does not end on the hour)", () => {
    const xs = [0, 100, 200, 290], ws = [44, 44, 44, 44];
    expect(thinTicks(xs, ws, 300, ["start", "middle", "middle", "middle"])).toEqual([0, 1, 2, 3]);
  });
});
