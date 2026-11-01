import { describe, expect, it } from "vitest";
import { agrees, cardHeading, checkPhoto, countNote, PHOTO_MAX_BYTES, pinLabel, retryAtText, ringColour, sizeMB, sourceWords, uploadProblem, waterInPhoto } from "./observations";

const base = { est_depth_m: 0.4, depth_low_m: null, depth_high_m: null, sim_depth_m: null };

describe("agrees", () => {
  it("is inside the photo's range when there is one", () => {
    expect(agrees({ ...base, depth_low_m: 0.3, depth_high_m: 0.6, sim_depth_m: 0.52 })).toBe(true);
    expect(agrees({ ...base, depth_low_m: 0.3, depth_high_m: 0.6, sim_depth_m: 0.61 })).toBe(false);
    expect(agrees({ ...base, depth_low_m: 0.3, depth_high_m: 0.6, sim_depth_m: 0.3 })).toBe(true);
  });
  it("uses max(0.1 m, 35 %) of the estimate when there is no range", () => {
    expect(agrees({ ...base, sim_depth_m: 0.5 })).toBe(true);
    expect(agrees({ ...base, sim_depth_m: 0.56 })).toBe(false);
    expect(agrees({ ...base, est_depth_m: 0.1, sim_depth_m: 0.19 })).toBe(true);
    expect(agrees({ ...base, est_depth_m: 0.1, sim_depth_m: 0.21 })).toBe(false);
  });
  it("is null when the model or the estimate is unknown", () => {
    expect(agrees(base)).toBeNull();
    expect(agrees({ ...base, est_depth_m: null, sim_depth_m: 0.4 })).toBeNull();
  });
});

describe("wording", () => {
  it("labels a pin with both depths, or the photo's alone", () => {
    expect(pinLabel({ est_depth_m: 0.4, sim_depth_m: 0.52 })).toBe("0.40 m · model 0.52");
    expect(pinLabel({ est_depth_m: 0.4, sim_depth_m: null })).toBe("0.40 m");
    expect(pinLabel({ est_depth_m: null, sim_depth_m: null })).toBe("No depth read");
  });
  it("gives the range in the water line", () => {
    expect(waterInPhoto({ est_depth_m: 0.4, depth_low_m: 0.3, depth_high_m: 0.6 })).toBe("0.40 m (0.30–0.60)");
    expect(waterInPhoto({ est_depth_m: 0.4, depth_low_m: null, depth_high_m: null })).toBe("0.40 m");
    expect(waterInPhoto({ est_depth_m: null, depth_low_m: null, depth_high_m: null })).toBeNull();
  });
  it("words the source and the heading", () => {
    expect(sourceWords({ source: "citizen_photo" })).toBe("a resident's photo");
    expect(sourceWords({ source: "drone_video" })).toBe("a drone video");
    expect(sourceWords({ source: "satellite_chip" })).toBe("a satellite image");
    expect(cardHeading({ source: "citizen_photo" }, "T+02:40")).toBe("Water outline from a resident's photo · T+02:40");
    expect(cardHeading({ source: "drone_video" }, null)).toBe("Water outline from a drone video");
  });
  it("counts the area and colours the ring", () => {
    expect(countNote(0)).toBe("None yet");
    expect(countNote(3)).toBe("3 in this area");
    expect(ringColour(true)).toBe("var(--verified)");
    expect(ringColour(false)).toBe("var(--danfo)");
    expect(ringColour(null)).toBe("var(--ink-muted)");
  });
});

describe("upload checks", () => {
  it("accepts JPEG, PNG and WebP up to 8 MB", () => {
    expect(checkPhoto({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(checkPhoto({ type: "image/png", size: 1000 })).toBeNull();
    expect(checkPhoto({ type: "image/webp", size: PHOTO_MAX_BYTES })).toBeNull();
  });
  it("refuses the wrong type first, then a file over 8 MB", () => {
    expect(checkPhoto({ type: "image/gif", size: 10 })?.title).toBe("That file isn't a JPEG, PNG or WebP photo.");
    expect(checkPhoto({ type: "image/jpeg", size: PHOTO_MAX_BYTES + 1 })?.title).toBe("That photo is over 8 MB.");
  });
  it("prints the size to one decimal", () => {
    expect(sizeMB(1.25 * 1024 * 1024)).toBe("1.3 MB");
    expect(sizeMB(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(sizeMB(700)).toBe("under 0.1 MB");
  });
});

describe("upload problems", () => {
  it("maps each status to its copy", () => {
    expect(uploadProblem(400).title).toBe("No water found in this photo.");
    expect(uploadProblem(413).title).toBe("That photo is over 8 MB.");
    expect(uploadProblem(415).title).toBe("That file isn't a JPEG, PNG or WebP photo.");
    expect(uploadProblem(502).next).toBe("Nothing was saved. Try again in a minute.");
    expect(uploadProblem(401).key).toBe(true);
    expect(uploadProblem(403).key).toBe(true);
    expect(uploadProblem(500).key).toBeUndefined();
  });
  it("gives the local time to retry at for a 429", () => {
    const now = new Date(2026, 10, 1, 14, 20, 0);
    expect(retryAtText(600, now)).toBe("14:30");
    expect(uploadProblem(429, 600, now).next).toBe("Try again at 14:30");
    expect(retryAtText(undefined, now)).toBe("14:20");
  });
});
