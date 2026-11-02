import { describe, expect, it } from "vitest";
import { addEscape, addFocus, agrees, cardHeading, checkPhoto, countNote, focusBack, NO_WATER, noWater, PHOTO_MAX_BYTES, pinLabel, retryAtText, ringColour, sizeMB, sourceWords, takesFocus, uploadProblem, waterInPhoto } from "./observations";
import type { UploadProblem } from "./observations";

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
    expect(uploadProblem(400).title).toBe("The photo could not be read.");  // unreadable image or a bad field, not "no water"
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
  it("tells a key lockout from the hourly limit on a 429", () => {
    const now = new Date(2026, 10, 1, 15, 24);
    expect(uploadProblem(429, 840, now).title).toBe("Twenty photos this hour already.");
    expect(uploadProblem(429, 840, now).next).toBe("Try again at 15:38");
    const locked = uploadProblem(429, 840, now, true);
    expect(locked.key).toBe(true);
    expect(locked.title).toMatch(/needs the judge key/);
  });
  it("treats a photo without flood water as no water, kept off the map", () => {
    expect(noWater({ est_depth_m: null, water_fraction: 0 })).toBe(true);
    expect(noWater({ est_depth_m: null, water_fraction: 0.2 })).toBe(false);
    expect(noWater({ est_depth_m: 0.3, water_fraction: 0.005 })).toBe(false);
    expect(NO_WATER.title).toBe("No water found in this photo.");
  });
});

describe("the add card's keyboard path", () => {
  const key: UploadProblem = uploadProblem(403);
  it("focuses each state's main action", () => {
    expect(addFocus("choose", null, false)).toBe("choose");
    expect(addFocus("choose", checkPhoto({ type: "application/pdf", size: 1 }), false)).toBe("choose");  // a bad first pick
    expect(addFocus("ready", null, false)).toBe("send");
    expect(addFocus("reading", null, false)).toBe("abort");
    expect(addFocus("ready", uploadProblem(502), false)).toBe("send");   // retry
    expect(addFocus("ready", uploadProblem(429, 60), false)).toBe("send");
    expect(addFocus("ready", NO_WATER, false)).toBe("another");
    expect(addFocus("ready", uploadProblem(413), false)).toBe("another");
    expect(addFocus("ready", uploadProblem(415), false)).toBe("another");
    expect(addFocus("ready", checkPhoto({ type: "image/jpeg", size: 9e6 }), false)).toBe("another");
  });
  it("keeps focus off a disabled Send during a key lockout", () => {
    expect(addFocus("ready", key, true)).toBe("cancel");
    expect(addFocus("ready", null, true)).toBe("cancel");
    expect(addFocus("ready", key, false)).toBe("send");  // the lockout ended: Send is back
  });
  it("at a lockout's end, focus moves to Send only from Cancel or from nowhere", () => {
    const end = { opened: true, dropped: false, inCard: true, from: "cancel" as const, to: "send" as const };
    expect(takesFocus({ ...end, onFrom: true })).toBe(true);                    // still on Cancel
    expect(takesFocus({ ...end, onFrom: false })).toBe(false);                  // moved to another control in the card
    expect(takesFocus({ ...end, inCard: false, onFrom: false })).toBe(false);   // moved out of the card
    expect(takesFocus({ ...end, dropped: true, inCard: false, onFrom: false })).toBe(true);  // focus was dropped
  });
  it("other changes take focus on opening, when dropped, or while focus is in the card", () => {
    const ch = { opened: true, dropped: false, from: "choose" as const, to: "send" as const, onFrom: false };
    expect(takesFocus({ ...ch, opened: false, inCard: false })).toBe(true);
    expect(takesFocus({ ...ch, inCard: true })).toBe(true);
    expect(takesFocus({ ...ch, inCard: false })).toBe(false);
    expect(takesFocus({ ...ch, from: "send", to: "cancel", inCard: true })).toBe(true);  // a lockout starts: off the disabled Send
  });
  it("Esc closes, and aborts a read first", () => {
    expect(addEscape("choose")).toEqual(["close"]);
    expect(addEscape("ready")).toEqual(["close"]);
    expect(addEscape("reading")).toEqual(["abort", "close"]);
  });
  it("gives focus back where it came from, or to the map when that is gone", () => {
    const canvas = { isConnected: true, n: "canvas" }, layers = { isConnected: true, n: "layers" }, gone = { isConnected: false, n: "gone" };
    expect(focusBack(layers, canvas)).toBe(layers);
    expect(focusBack(gone, canvas)).toBe(canvas);
    expect(focusBack(null, canvas)).toBe(canvas);
  });
});
