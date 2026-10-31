import { describe, expect, it } from "vitest";

// Changing the area destroys the Cesium viewer before the map layers' effects clean up, and a destroyed viewer's
// getters (canvas, scene, camera) throw, which blanked the whole page. Cleanups and early-outs must use what the
// effect captured, or check isDestroyed() first.
const raw = import.meta.glob<string>("../components/*.tsx", { query: "?raw", import: "default", eager: true });
const files = Object.entries(raw).map(([path, src]) => ({ f: path.split("/").pop()!, src }));

/** The body of every `return () => …` in the file (a braced block, or the rest of the line). */
function cleanups(src: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
  for (const m of src.matchAll(/return \(\) => /g)) {
    const i = m.index! + m[0].length;
    let body: string;
    if (src[i] === "{") {
      let d = 0, j = i;
      for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) break; }
      body = src.slice(i, j + 1);
    } else body = src.slice(i, src.indexOf("\n", i));
    out.push({ line: src.slice(0, m.index).split("\n").length, body });
  }
  return out;
}

describe("map layers survive the viewer being destroyed", () => {
  it("no cleanup reads a viewer getter without checking isDestroyed()", () => {
    const bad = files.flatMap(({ f, src }) => cleanups(src)
      .filter(({ body }) => /\bviewer!?\.(canvas|scene|camera)\b/.test(body) && !body.includes("isDestroyed"))
      .map(({ line }) => `${f}:${line}`));
    expect(bad).toEqual([]);
  });

  it("no optional-chained getter on a viewer that may be destroyed", () => {
    const bad = files.flatMap(({ f, src }) => src.split("\n").flatMap((l, i) => (/\bviewer\?\.(canvas|scene|camera)\b/.test(l) ? [`${f}:${i + 1}`] : [])));
    expect(bad).toEqual([]);
  });
});
