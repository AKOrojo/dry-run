// Latest-wins guard for overlapping async reads: each call starts a read and returns a check that stays true only until
// the next call. Separate guards never cancel each other.
export function latestOnly(): () => () => boolean {
  let n = 0;
  return () => { const mine = ++n; return () => mine === n; };
}
