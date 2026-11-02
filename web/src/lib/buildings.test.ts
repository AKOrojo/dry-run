import { afterEach, describe, expect, it, vi } from "vitest";
import { buildingToken } from "./buildings";
import { perTheme } from "./theme";

describe("buildingToken", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("dry under 0.15 m, then one depth token per bin", () => {
    expect(buildingToken(0)).toBe("--ink-muted");
    expect(buildingToken(0.1)).toBe("--ink-muted");
    expect(buildingToken(Number.NaN)).toBe("--ink-muted");
    expect(buildingToken(0.15)).toBe("--depth-2");
    expect(buildingToken(0.3)).toBe("--depth-3");
    expect(buildingToken(0.5)).toBe("--depth-4");
    expect(buildingToken(1)).toBe("--depth-5");
    expect(buildingToken(2.5)).toBe("--depth-6");
  });

  it("a theme switch repaints a building in the new theme's token value", () => {
    const html = { dataset: {} as Record<string, string | undefined> };
    vi.stubGlobal("document", { documentElement: html });
    const values: Record<string, Record<string, string>> = { dark: { "--depth-3": "#1d4f91" }, light: { "--depth-3": "#7fb2e5" } };
    const color = perTheme((name) => values[html.dataset.theme ?? "dark"][name]);
    expect(color(buildingToken(0.4))).toBe("#1d4f91");
    html.dataset.theme = "light";
    expect(color(buildingToken(0.4))).toBe("#7fb2e5");
  });
});
