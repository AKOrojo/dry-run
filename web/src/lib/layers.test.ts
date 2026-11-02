import { describe, expect, it } from "vitest";
import { ionDownPatch, OSM_NOTE, resolveAerial } from "./layers";

describe("aerial source with Cesium ion down", () => {
  it("puts the street map in place of Bing, with its note unless one says more", () => {
    expect(resolveAerial("bing", null, true)).toEqual({ aerial: "osm", aerialNote: OSM_NOTE });
    expect(resolveAerial("bing", "Google imagery needs the judge key.", true)).toEqual({ aerial: "osm", aerialNote: "Google imagery needs the judge key." });
  });
  it("leaves Google, and every choice while ion works, as picked", () => {
    expect(resolveAerial("google", null, true)).toEqual({ aerial: "google", aerialNote: null });
    expect(resolveAerial("bing", null, false)).toEqual({ aerial: "bing", aerialNote: null });
  });
  it("keeps Google showing when ion refuses, otherwise switches to the street map", () => {
    expect(ionDownPatch({ aerial: "google", aerialNote: null })).toEqual({ aerial: "google", aerialNote: null, ionDown: true });
    expect(ionDownPatch({ aerial: "bing", aerialNote: null })).toEqual({ aerial: "osm", aerialNote: OSM_NOTE, ionDown: true });
  });
});
