import { describe, expect, it } from "vitest";
import { firstDryAfter, fmtEta, fmtKm, framesAfter, nearestFrame } from "./saferoute";

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
});
