// First-visit tour state, kept out of Tour.tsx so App can check it without loading the tour's chunk.
const DONE_KEY = "dr_tour_done";

export function tourDone(): boolean {
  try { return localStorage.getItem(DONE_KEY) === "1"; } catch { return false; }
}
export function markTourDone() {
  try { localStorage.setItem(DONE_KEY, "1"); } catch { /* storage unavailable */ }
}
export function tourDisabled(): boolean {
  try { return new URLSearchParams(window.location.search).get("notour") === "1"; } catch { return false; }
}
