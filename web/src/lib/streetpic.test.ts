import { describe, expect, it } from "vitest";
import { aboutMetres, clockText, DRY, fitBox, imageUrl, legendLine, isDryInBoth, makingNote, mismatchNote, renderLink, renderProblem, retryIn, sourceNote, USUAL_MAX_S } from "./streetpic";

const im = (depth_m: number, picture_depth_m: number | null, picture_matches: boolean | null) =>
  ({ url: "/api/render/v_0123456789abcdef/before.webp", run_id: "r_0123456789abcdef", depth_m, depth_text: "", picture_depth_m, picture_matches });

describe("street picture", () => {
  it("is dry only when both runs stay under the server's minimum", () => {
    expect(isDryInBoth(0.01, 0.02)).toBe(true);
    expect(isDryInBoth(0.01, 0.3)).toBe(false);
    expect(isDryInBoth(undefined, 0.01)).toBe(false);  // unknown: let the server decide
  });
  it("shows elapsed time and the usual range, never an estimate", () => {
    expect(clockText(75)).toBe("1:15");
    expect(makingNote(USUAL_MAX_S)).toBe("usually 50–90 s");
    expect(makingNote(USUAL_MAX_S + 1)).toBe("taking longer than usual");
  });
  it("notes the first picture whose water is off the model", () => {
    expect(mismatchNote({ before: im(0.57, 0.25, false), after: im(0.12, 0.1, true) })).toEqual({ which: "before", shows: 0.25, model: 0.57 });
    expect(mismatchNote({ before: im(0.57, 0.5, true), after: im(0.12, null, null) })).toBeNull();
    expect(aboutMetres(0.25)).toBe("about 0.25 m");
    expect(aboutMetres(null)).toBe("not checked");
  });
  it("says what the picture is drawn from", () => {
    expect(sourceNote({ label: "AI illustration, not a measurement", source_photo: "generated" })).toMatch(/^AI illustration, not a measurement\. A typical street here/);
    expect(sourceNote({ source_photo: "uploaded" })).toMatch(/Your photo/);
  });
  it("builds image and share links", () => {
    expect(imageUrl("", "/api/render/v_1/after.webp")).toBe("/api/render/v_1/after.webp");
    expect(imageUrl("https://x.run.app/", "/api/render/v_1/after.webp")).toBe("https://x.run.app/api/render/v_1/after.webp");
    expect(renderLink("https://dryrun.app/?aoi=x&run=r_1&t=60#a", "lagos-lekki-v3", "v_0123456789abcdef")).toBe("https://dryrun.app/?aoi=lagos-lekki-v3&render=v_0123456789abcdef");
  });
  it("maps server failures to the board's problem rows", () => {
    expect(renderProblem(403, "").action).toBe("key");
    expect(renderProblem(429, "", 60, new Date(), true).action).toBe("key");  // a key lockout, not the hourly cap
    expect(renderProblem(422, "The image model's content filter declined this picture. Try another spot.").title).toBe("The image model declined this picture");
    expect(renderProblem(400, "no water at this spot in either run: pick a flooded street")).toBe(DRY);
    expect(renderProblem(429, "", 14 * 60 - 20)).toMatchObject({ title: "Too many new pictures this hour", detail: "Try again in 14 min. Pictures already made still open." });
    expect(renderProblem(503, "").title).toMatch(/not set up/);
    expect(retryIn(undefined)).toBe("Try again later.");
  });
});

describe("phone large view", () => {
  it("fits by width when the room is tall, by height when it is short, never cropping", () => {
    expect(fitBox(358, 600, 1.6)).toEqual({ w: 358, h: 223 });   // a 640×400 picture on a 390 px phone: full width
    expect(fitBox(358, 600, 0.75)).toEqual({ w: 358, h: 477 });  // a tall picture that still fits by width
    expect(fitBox(358, 400, 0.75)).toEqual({ w: 300, h: 400 });  // too tall for the room: fits by height
    expect(fitBox(800, 300, 1.6)).toEqual({ w: 480, h: 300 });   // a wide, short room: by height
  });
  it("says each side's run and model depth in full in the legend", () => {
    expect(legendLine("A", "Baseline", 0.13)).toBe("A · Baseline · model 0.13 m");
    expect(legendLine("B", "Baseline", 0.48)).toBe("B · Baseline · model 0.48 m");
    expect(legendLine("A", undefined, 0.13)).toBe("A · model 0.13 m");  // a link opened before the runs load
  });
});
