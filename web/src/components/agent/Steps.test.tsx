import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent } from "../../lib/api";
import { Stepper, briefPhase, lastBudget } from "./Steps";

const ev = (kind: AgentEvent["kind"], data: Record<string, unknown> = {}) => ({ kind, data }) as AgentEvent;

describe("briefPhase", () => {
  it("starts at the server's phase event, not at the last tool step", () => {
    const events = [ev("tool_call", { name: "get_aoi_info" }), ev("tool_result", { name: "get_aoi_info" }),
      ev("phase", { phase: "brief", model: "Muse Glimmer 30B" })];
    expect(briefPhase(events, [1000, 2000, 5000])).toEqual({ model: "Muse Glimmer 30B", t0: 5000 });
  });
  it("is absent until the phase event arrives", () => {
    expect(briefPhase([ev("tool_call", { name: "get_aoi_info" })], [1000])).toBeUndefined();
  });
});

describe("Stepper writing row", () => {
  it("names the model and shows the elapsed time as m:ss", () => {
    const html = renderToStaticMarkup(<Stepper steps={[]} running thought={undefined} now={5000 + 125_000}
      onRun={() => {}} writing={{ model: "Muse Glimmer 30B", t0: 5000 }} />);
    expect(html).toContain("Writing the brief · Muse Glimmer 30B");
    expect(html).toContain("2:05");
    expect(html).toContain("dr-indet");
  });
});

describe("lastBudget", () => {
  const result = (elapsed_s: number, deadline_s: number) =>
    ev("tool_result", { name: "run_simulation", result: {}, budget: { runs_used: 1, runs_max: 6, elapsed_s, deadline_s } });
  it("reads the limit the server sends: a waking model's request cap", () => {
    expect(lastBudget([result(7, 240), result(410, 840)])).toMatchObject({ elapsed_s: 410, deadline_s: 840 });
  });
  it("never reads elapsed past its limit", () => {
    expect(lastBudget([result(251.3, 240)])).toMatchObject({ elapsed_s: 240, deadline_s: 240 });
  });
  it("is absent before the first tool result", () => {
    expect(lastBudget([ev("thought", { text: "hi" })])).toBeUndefined();
  });
});
