/** Building depth bins: lower edges in metres -> tokens --depth-1..6. */
export const DEPTH_EDGES = [0.05, 0.15, 0.3, 0.5, 1, 2];

/** The colour token for a building flooded to `depth` metres; under 0.15 m it reads as dry. */
export function buildingToken(depth: number): string {
  if (!(depth >= 0.15)) return "--ink-muted";
  let bin = 0;
  DEPTH_EDGES.forEach((edge, i) => { if (depth >= edge) bin = i; });
  return `--depth-${bin + 1}`;
}
