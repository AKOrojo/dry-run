import { describe, expect, it } from "vitest";
import { buttonStyle } from "./Button";
import { raisedButton } from "../rev5";

describe("buttonStyle", () => {
  it("raised is the rev5 raised look, and the call site's own border wins over it", () => {
    expect(buttonStyle("raised", false, false)).toEqual(raisedButton);
    expect(buttonStyle("raised", false, false, { border: "1px solid var(--hairline)" })).toMatchObject({ background: "var(--raised-bg)", border: "1px solid var(--hairline)" });
  });

  it("the call site's style is spread after the base, so its values win", () => {
    expect(buttonStyle("text", false, false).color).toBe("var(--ink-muted)");
    expect(buttonStyle("text", false, false, { color: "var(--ink)" }).color).toBe("var(--ink)");
  });

  it("segment: the pressed segment is inked and semibold, the others are transparent", () => {
    expect(buttonStyle("segment", true, false)).toMatchObject({ background: "var(--pressed-bg)", color: "var(--ground)", fontWeight: 600 });
    expect(buttonStyle("segment", false, false)).toMatchObject({ background: "transparent", color: "var(--ink-muted)", padding: "0 9px" });
    expect(buttonStyle("segment", false, false).fontWeight).toBe("inherit");
  });

  it("font: inherit becomes longhands with a weight in every state, so a toggled fontWeight never sits beside a shorthand", () => {
    for (const pressed of [true, false]) {
      const s = buttonStyle("segment", pressed, false, { font: "inherit", fontSize: 12 });
      expect(s.font).toBeUndefined();
      expect(s).toMatchObject({ fontFamily: "inherit", lineHeight: "inherit", fontSize: 12, fontWeight: pressed ? 600 : "inherit" });
    }
    expect(buttonStyle("text", false, false, { fontWeight: 600 })).toMatchObject({ fontFamily: "inherit", fontWeight: 600 });
    expect(buttonStyle("raised", false, false, { font: "600 12px serif" }).font).toBe("600 12px serif");
  });

  it("icon is borderless with no padding; the call site keeps its own size and colour", () => {
    expect(buttonStyle("icon", false, false)).toEqual({ background: "transparent", border: 0, padding: 0, cursor: "pointer" });
    expect(buttonStyle("icon", false, false, { width: 26, color: "var(--ink)" })).toMatchObject({ width: 26, color: "var(--ink)" });
  });

  it("danfo is the primary fill with the on-danfo ink", () => {
    expect(buttonStyle("danfo", false, false)).toMatchObject({ color: "var(--on-danfo)", border: "1px solid var(--danfo-edge)" });
    expect(buttonStyle("danfo", false, false).background).toContain("var(--danfo)");
  });

  it("one disabled look for every variant, applied last so it beats the call site's opacity and cursor", () => {
    for (const v of ["raised", "text", "icon", "danfo"] as const) {
      expect(buttonStyle(v, false, true, { opacity: 0.6, cursor: "pointer" })).toMatchObject({ opacity: 0.45, cursor: "default" });
      expect(buttonStyle(v, false, false, { cursor: "pointer" })).toMatchObject({ cursor: "pointer" });
      expect(buttonStyle(v, false, false).opacity).toBeUndefined();
    }
  });
});
