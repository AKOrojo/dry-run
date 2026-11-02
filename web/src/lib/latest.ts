// Latest-wins guard for overlapping async reads: each call starts a read and returns a check that stays true only until
// the next call. Separate guards never cancel each other.
export function latestOnly(): () => () => boolean {
  let n = 0;
  return () => { const mine = ++n; return () => mine === n; };
}

/** Newer-wins guard for a stream of reads: `start()` begins a read and returns `take`, which says whether its reply may
 *  be applied and, if so, records it as the last applied. A reply applies when it is newer than the last one applied,
 *  even if later reads are still pending, so slow replies still land in order; an older reply after a newer one is
 *  dropped. `reset()` starts a new epoch: every read pending at that moment is dropped. */
export function newerOnly(): { start: () => () => boolean; reset: () => void } {
  let sent = 0, applied = 0, epoch = 0;
  return {
    start: () => {
      const mine = ++sent, at = epoch;
      return () => {
        if (at !== epoch || mine <= applied) return false;
        applied = mine;
        return true;
      };
    },
    reset: () => { epoch++; },
  };
}
