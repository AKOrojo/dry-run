// Caches that hold one area's data (footprints, drains, frames, run json). Switching areas clears them, so the last
// area's parsed GeoJSON and decoded frames do not stay in memory for the rest of the session.
const caches = new Set<Map<unknown, unknown>>();

export function areaCache<K, V>(): Map<K, V> {
  const m = new Map<K, V>();
  caches.add(m as Map<unknown, unknown>);
  return m;
}

export function clearAreaCaches() {
  for (const m of caches) m.clear();
}
