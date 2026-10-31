import { describe, expect, it } from "vitest";
import pkg from "cesium/package.json";
import { CESIUM_CHECKED } from "./cesiumPin";

describe("Cesium version", () => {
  it("is the one the leak workarounds in Globe.tsx were checked against", () => {
    // On an upgrade: re-check clearStaleRequests and the frameState/context release in Globe.tsx, then bump CESIUM_CHECKED.
    expect(pkg.version).toBe(CESIUM_CHECKED);
  });
});
