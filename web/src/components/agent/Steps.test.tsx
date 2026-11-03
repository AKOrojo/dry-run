import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent } from "../../lib/api";
import { Stepper, briefPhase } from "./Steps";

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
