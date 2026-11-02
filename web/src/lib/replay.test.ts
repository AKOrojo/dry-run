import { describe, expect, it } from "vitest";
import { replayHint } from "./replay";

const REC = ["How much does a 1 m higher lagoon flood Lekki?"];

describe("replayHint", () => {
  it("shows for your own question while Replay is on", () => {
    expect(replayHint("replay", "Where do the roads cut first?", REC)).toBe(true);
  });
  it("stays away while the box is empty or blank", () => {
    expect(replayHint("replay", "", REC)).toBe(false);
    expect(replayHint("replay", "   ", REC)).toBe(false);
  });
  it("stays away for a recorded question", () => {
    expect(replayHint("replay", REC[0], REC)).toBe(false);
  });
  it("stays away under Live and Fake", () => {
    expect(replayHint("fake", "Where do the roads cut first?", REC)).toBe(false);
    expect(replayHint("meta", "Where do the roads cut first?", REC)).toBe(false);
  });
});
