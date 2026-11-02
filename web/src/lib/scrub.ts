// Keys on a time scrubber (the phone player and the desktop dock's timeline): the arrows step about 1/36 of the run
// (at least a minute), Home and End go to the ends. The time it lands on, or null for a key it does not use.
export function scrubKey(key: string, t: number, durS: number): number | null {
  const step = Math.max(60, durS / 36);
  const to = key === "ArrowRight" || key === "ArrowUp" ? t + step
    : key === "ArrowLeft" || key === "ArrowDown" ? t - step
    : key === "Home" ? 0
    : key === "End" ? durS
    : null;
  return to === null ? null : Math.min(durS, Math.max(0, to));
}
