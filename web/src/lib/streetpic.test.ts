import { describe, expect, it } from "vitest";
import { aboutMetres, DRY, EXPECT_S, imageUrl, isDryInBoth, leftText, mismatchNote, progressOf, renderLink, renderProblem, retryIn, sourceNote, stepAt } from "./streetpic";

const im = (depth_m: number, picture_depth_m: number | null, picture_matches: boolean | null) =>
  ({ url: "/api/render/v_0123456789abcdef/before.webp", run_id: "r_0123456789abcdef", depth_m, depth_text: "", picture_depth_m, picture_matches });

describe("street picture", () => {
  it("is dry only when both runs stay under the server's minimum", () => {
    expect(isDryInBoth(0.01, 0.02)).toBe(true);
    expect(isDryInBoth(0.01, 0.3)).toBe(false);
    expect(isDryInBoth(undefined, 0.01)).toBe(false);  // unknown: let the server decide
  });
  it("walks the steps and the estimate with the elapsed time", () => {
    expect(stepAt(0)).toBe(0);
    expect(stepAt(EXPECT_S * 0.6)).toBe(1);
    expect(stepAt(EXPECT_S)).toBe(2);
    expect(leftText(EXPECT_S - 45)).toBe("about 45 s left");
    expect(leftText(EXPECT_S + 10)).toBe("almost done");
    expect(progressOf(EXPECT_S * 3)).toBeLessThan(1);
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
    expect(renderProblem(429, "", 14 * 60 - 20).detail).toBe("New pairs are capped each hour. Try again in 14 min.");
    expect(renderProblem(503, "").title).toMatch(/not set up/);
    expect(retryIn(undefined)).toBe("Try again later.");
  });
});
