import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getGoogleTilesKey } from "./api";
import { clearLockout, lockoutText, noteLockout, readLockout } from "./lockout";

// sessionStorage as in a browser tab (Node has none).
const store = new Map<string, string>();
vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const reply = (status: number, headers: Record<string, string>) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "too many wrong keys; try again in 15 min", retryable: true } }),
    { status, headers: { "content-type": "application/json", ...headers } })));

describe("judge-key lockout", () => {
  beforeEach(() => { store.clear(); });

  it("a 429 with X-Auth-Lockout is kept in sessionStorage and runs out on time", async () => {
    reply(429, { "Retry-After": "901", "X-Auth-Lockout": "ip" });
    const err = await getGoogleTilesKey().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.lockout).toBe("ip");
    const lock = readLockout();
    expect(lock?.scope).toBe("ip");
    expect(readLockout(Date.now() + 900_000)).not.toBeNull();
    expect(readLockout(Date.now() + 902_000)).toBeNull();  // expired: the key box unlocks
  });

  it("an ordinary 429 (no X-Auth-Lockout) is not a lockout", async () => {
    reply(429, { "Retry-After": "60" });
    const err = await getGoogleTilesKey().catch((e) => e);
    expect(err.lockout).toBeUndefined();
    expect(err.retryAfterS).toBe(60);
    expect(readLockout()).toBeNull();
  });

  it("global and ip read differently and count down in minutes, then seconds", () => {
    expect(lockoutText("ip", 901)).toBe("Too many wrong keys. Try again in 15 min.");
    expect(lockoutText("ip", 61)).toBe("Too many wrong keys. Try again in 1 min.");
    expect(lockoutText("global", 45.2)).toBe("Key checks are paused for everyone for 46 s.");
  });

  it("ignores junk headers and keeps the longer lock", () => {
    noteLockout("admin", 600);
    noteLockout("ip", 0);
    expect(readLockout()).toBeNull();
    const now = Date.now();
    noteLockout("ip", 1800, now);
    noteLockout("ip", 60, now);
    expect(readLockout(now)!.until).toBe(now + 1_800_000);
    clearLockout();
    expect(readLockout()).toBeNull();
  });
});
