import { describe, expect, it } from "vitest";
import { firstDryAfter, fmtEta, fmtKm, framesAfter, nearestFrame, routeError, samePath, samplePath, shelterName, wetRuns } from "./saferoute";

const times = [0, 600, 1200, 1800, 2400];

describe("nearestFrame", () => {
  it("picks the frame time closest to the playhead", () => {
    expect(nearestFrame(times, 0)).toBe(0);
    expect(nearestFrame(times, 890)).toBe(600);
    expect(nearestFrame(times, 910)).toBe(1200);
    expect(nearestFrame(times, 99999)).toBe(2400);
  });

  it("is null without frames", () => {
    expect(nearestFrame([], 300)).toBeNull();
  });
});

describe("framesAfter", () => {
  it("lists the later frames in order", () => {
    expect(framesAfter(times, 600)).toEqual([1200, 1800, 2400]);
    expect(framesAfter([2400, 0, 1200], 0)).toEqual([1200, 2400]);
    expect(framesAfter(times, 2400)).toEqual([]);
  });
});

describe("firstDryAfter", () => {
  const signal = () => new AbortController().signal;

  it("returns the first dry frame after the playhead and stops probing there", async () => {
    const probed: number[] = [];
    const dry = await firstDryAfter(times, 600, async (f) => { probed.push(f); return f === 1800; }, signal());
    expect(dry).toBe(1800);
    expect(probed).toEqual([1200, 1800]);
  });

  it("is null when no later frame is dry (the run end is the last frame)", async () => {
    expect(await firstDryAfter(times, 600, async () => false, signal())).toBeNull();
  });

  it("stops at the probe limit", async () => {
    const probed: number[] = [];
    expect(await firstDryAfter(times, 0, async (f) => { probed.push(f); return false; }, signal(), 2)).toBeNull();
    expect(probed).toEqual([600, 1200]);
  });

  it("throws when the request is aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(firstDryAfter(times, 0, async () => true, ctl.signal)).rejects.toThrow();
  });
});

describe("formatting", () => {
  it("shows distance to one decimal and walking time in whole minutes, at least one", () => {
    expect(fmtKm(3.4)).toBe("3.4 km");
    expect(fmtKm(0.04)).toBe("0.0 km");
    expect(fmtEta(10.6)).toBe("about 11 min");
    expect(fmtEta(0.2)).toBe("about 1 min");
  });
  it("tells a cut usual route from the same one", () => {
    expect(samePath([[3.5, 6.4], [3.6, 6.5]], [[3.5, 6.4], [3.6, 6.5]])).toBe(true);
    expect(samePath([[3.5, 6.4], [3.6, 6.5]], [[3.5, 6.4], [3.61, 6.5]])).toBe(false);
    expect(samePath([[3.5, 6.4]], undefined)).toBe(false);
  });
  it("names the shelter once", () => {
    expect(shelterName("Ajah Primary School")).toBe("Ajah Primary School (shelter)");
    expect(shelterName("Catholic Church (candidate shelter (assumed))")).toBe("Catholic Church (candidate shelter (assumed))");
    expect(shelterName(null)).toBe("Nearest shelter");
  });
  it("samples a path evenly, within the bounds", () => {
    const path: [number, number][] = [[3.5, 6.4], [3.51, 6.4]];  // about 1.1 km
    const pts = samplePath(path, 30, 12, 40);
    expect(pts.length).toBe(38);
    expect(pts[0]).toEqual([3.5, 6.4]);
    expect(pts.at(-1)?.[0]).toBeCloseTo(3.51, 9);
    expect(samplePath(path, 1000, 12, 40).length).toBe(12);
    expect(samplePath(path, 1, 12, 40).length).toBe(40);
  });
  it("marks each wet stretch once, at its middle", () => {
    const s: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]];
    expect(wetRuns(s, [false, true, true, true, false, true])).toEqual([[2, 0], [5, 0]]);
    expect(wetRuns(s, [false, false, false, false, false, false])).toEqual([]);
  });
  it("puts route errors in plain words", () => {
    expect(routeError("point (3.54500, 6.47419) is more than 300 m from any road")).toBe("This spot is too far from a road. Pick one on or near a street.");
    expect(routeError("500")).toMatch(/could not be worked out/);
  });
});
