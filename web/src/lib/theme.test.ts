import { afterEach, describe, expect, it, vi } from "vitest";
import { perTheme, subscribeTheme } from "./theme";

// A stand-in <html> whose data-theme the tests flip, and a MutationObserver that reports attribute changes on it.
function stubDom() {
  const watchers: { cb: () => void; filter?: string[] }[] = [];
  const html = { dataset: {} as Record<string, string | undefined> };
  const setTheme = (t: string) => { html.dataset.theme = t; watchers.forEach((w) => w.filter?.includes("data-theme") && w.cb()); };
  vi.stubGlobal("document", { documentElement: html });
  vi.stubGlobal("MutationObserver", class {
    w?: { cb: () => void; filter?: string[] };
    constructor(private cb: () => void) {}
    observe(target: unknown, o: { attributeFilter?: string[] }) { if (target === html) watchers.push((this.w = { cb: this.cb, filter: o.attributeFilter })); }
    disconnect() { const i = this.w ? watchers.indexOf(this.w) : -1; if (i >= 0) watchers.splice(i, 1); }
  });
  return { html, setTheme };
}

describe("theme", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("subscribeTheme fires on a data-theme change and stops after unsubscribe", () => {
    const { setTheme } = stubDom();
    const cb = vi.fn();
    const off = subscribeTheme(cb);
    setTheme("light");
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    setTheme("dark");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("perTheme reads each token once per theme and re-reads after a switch", () => {
    const { html, setTheme } = stubDom();
    const tokens: Record<string, Record<string, string>> = { dark: { "--ink": "#eee" }, light: { "--ink": "#111" } };
    const read = vi.fn((name: string) => tokens[html.dataset.theme ?? "dark"][name]);
    const color = perTheme(read);
    expect(color("--ink")).toBe("#eee");
    expect(color("--ink")).toBe("#eee");
    expect(read).toHaveBeenCalledTimes(1);
    setTheme("light");
    expect(color("--ink")).toBe("#111");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("perTheme does not keep a missing value", () => {
    stubDom();
    let v: string | undefined;
    const color = perTheme(() => v);
    expect(color("--x")).toBeUndefined();
    v = "#abc";
    expect(color("--x")).toBe("#abc");
  });
});
