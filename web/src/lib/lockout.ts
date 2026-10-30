// Judge-key lockout (Eng D, dryrun/api/authguard.py): after too many wrong keys the server answers 429 with
// Retry-After and X-Auth-Lockout: ip | global. The lockout is kept in sessionStorage so a reload does not hide it;
// requests without a key (the cached demo, Replay, Fake) are never locked.
import { useEffect, useState, useSyncExternalStore } from "react";

export type LockScope = "ip" | "global";
export type Lockout = { scope: LockScope; until: number };

const KEY = "dr_auth_lockout";
const subs = new Set<() => void>();
let cached: string | null | undefined;

const raw = (): string | null => {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
};
/** The stored lockout if it has not run out at `now`. */
export function readLockout(now = Date.now()): Lockout | null {
  try {
    const v = JSON.parse(raw() ?? "null") as Lockout | null;
    return v && (v.scope === "ip" || v.scope === "global") && typeof v.until === "number" && v.until > now ? v : null;
  } catch { return null; }
}
/** Record a lockout from a 429's headers; ignores anything that is not one. */
export function noteLockout(scope: string | null, retryAfterS: number | undefined, now = Date.now()) {
  if ((scope !== "ip" && scope !== "global") || !retryAfterS || retryAfterS <= 0) return;
  const next: Lockout = { scope, until: now + retryAfterS * 1000 };
  const cur = readLockout(now);
  if (cur && cur.until >= next.until && cur.scope === next.scope) return;
  try { sessionStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked: the 429 still shows */ }
  subs.forEach((f) => f());
}
export function clearLockout() {
  try { sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
  subs.forEach((f) => f());
}

/** "15 min" (to the nearest minute, as the server's own message) while a minute or more is left, then "45 s". */
export const lockoutLeft = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.ceil(s))} s`);
export const lockoutText = (scope: LockScope, leftS: number) =>
  scope === "ip" ? `Too many wrong keys. Try again in ${lockoutLeft(leftS)}.` : `Key checks are paused for everyone for ${lockoutLeft(leftS)}.`;

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const snapshot = () => { const r = raw(); if (r !== cached) cached = r; return cached ?? null; };

/** The live lockout with seconds left, ticking once a second; null when there is none. */
export function useLockout(): { scope: LockScope; leftS: number } | null {
  useSyncExternalStore(subscribe, snapshot);
  const [now, setNow] = useState(Date.now());
  const lock = readLockout(now);
  useEffect(() => {
    if (!lock) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [!!lock]);
  return lock ? { scope: lock.scope, leftS: (lock.until - now) / 1000 } : null;
}
