import { useSyncExternalStore } from "react";

// How many phone sheets are open over the map. Map chips at the bottom edge hide while one is (the sheet covers them).
let open = 0;
const subs = new Set<() => void>();
/** Mark a sheet open; the returned function marks it closed again. */
export function sheetOpened(): () => void {
  open++;
  subs.forEach((f) => f());
  let done = false;
  return () => { if (done) return; done = true; open--; subs.forEach((f) => f()); };
}
export const isSheetOpen = () => open > 0;
export const useSheetOpen = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, isSheetOpen);
