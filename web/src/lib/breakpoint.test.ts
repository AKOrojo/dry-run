import { afterEach, describe, expect, it, vi } from "vitest";
import { breakpointFor } from "./breakpoint";

describe("breakpointFor", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("phone under 600, tablet 600-1023, desktop from 1024", () => {
    expect(breakpointFor(320)).toBe("phone");
    expect(breakpointFor(390)).toBe("phone");
    expect(breakpointFor(599)).toBe("phone");
    expect(breakpointFor(600)).toBe("tablet");
    expect(breakpointFor(768)).toBe("tablet");
    expect(breakpointFor(1023)).toBe("tablet");
    expect(breakpointFor(1024)).toBe("desktop");
    expect(breakpointFor(1440)).toBe("desktop");
  });

  it("a phone on its side (under 500 px tall, under 1024 px wide) is a phone; desktop stays desktop", () => {
    expect(breakpointFor(844, 390)).toBe("phone");
    expect(breakpointFor(932, 430)).toBe("phone");
    expect(breakpointFor(1023, 499)).toBe("phone");
    expect(breakpointFor(768, 1024)).toBe("tablet");
    expect(breakpointFor(1023, 500)).toBe("tablet");
    expect(breakpointFor(1024, 400)).toBe("desktop");
    expect(breakpointFor(1280, 720)).toBe("desktop");
  });
});
