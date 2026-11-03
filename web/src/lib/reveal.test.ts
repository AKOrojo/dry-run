import { describe, expect, it } from "vitest";
import { revealIn } from "./reveal";

const node = (log: unknown[], name: string, parent: any = null): any => ({
  name, scrollIntoView: (o: unknown) => log.push([name, o]), closest: (s: string) => (s === "section" ? parent : null),
});

describe("revealIn", () => {
  it("scrolls the row itself just into view, smoothly", () => {
    const log: unknown[] = [];
    const row = node(log, "row");
    expect(revealIn({ querySelector: () => row }, "[data-agent-writing]", false, false)).toBe(true);
    expect(log).toEqual([["row", { block: "nearest", behavior: "smooth" }]]);
  });
  it("scrolls the whole card around a marker, without animation when motion is reduced", () => {
    const log: unknown[] = [];
    const card = node(log, "card");
    expect(revealIn({ querySelector: () => node(log, "marker", card) }, "[data-agent-failure]", true, true)).toBe(true);
    expect(log).toEqual([["card", { block: "nearest", behavior: "auto" }]]);
  });
  it("does nothing when the element is not rendered", () => {
    expect(revealIn({ querySelector: () => null }, "[data-agent-writing]", false, false)).toBe(false);
    expect(revealIn(null, "[data-agent-writing]", false, false)).toBe(false);
  });
});
