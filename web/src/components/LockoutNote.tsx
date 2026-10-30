// The judge-key lockout line under a key box (lib/lockout.ts): hazard colour, counting down.
import { lockoutText } from "../lib/lockout";
import type { LockScope } from "../lib/lockout";
import { FIG } from "./rev5";

export function LockoutNote({ lock }: { lock: { scope: LockScope; leftS: number } }) {
  return <span role="status" style={{ color: "var(--hazard)", fontSize: 12, lineHeight: "16px", ...FIG }}>{lockoutText(lock.scope, lock.leftS)}</span>;
}
