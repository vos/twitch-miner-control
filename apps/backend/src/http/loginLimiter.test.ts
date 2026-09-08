import { describe, expect, test } from "vitest";
import { LOCKOUT_MS, LoginLimiter, MAX_ATTEMPTS } from "./loginLimiter.js";

/** A limiter on a clock the test drives by hand. */
function limiter(start = 1_000_000) {
  let clock = start;
  const instance = new LoginLimiter(() => clock);
  return { instance, advance: (ms: number) => (clock += ms) };
}

describe("LoginLimiter", () => {
  test("allows an address that has never failed", () => {
    const { instance } = limiter();
    expect(instance.retryAfter("a")).toBe(0);
  });

  test("allows attempts right up to the limit", () => {
    const { instance } = limiter();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      expect(instance.fail("a")).toBe(false);
      expect(instance.retryAfter("a")).toBe(0);
    }
  });

  test("locks out on the attempt that reaches the limit", () => {
    const { instance } = limiter();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) instance.fail("a");
    expect(instance.fail("a")).toBe(true);
    expect(instance.retryAfter("a")).toBe(LOCKOUT_MS / 1000);
  });

  test("keeps refusing while the lockout is live", () => {
    const { instance, advance } = limiter();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) instance.fail("a");
    advance(LOCKOUT_MS - 1000);
    expect(instance.retryAfter("a")).toBe(1);
  });

  test("lets the address back in once the lockout elapses", () => {
    const { instance, advance } = limiter();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) instance.fail("a");
    advance(LOCKOUT_MS);
    expect(instance.retryAfter("a")).toBe(0);
  });

  // One noisy client on the LAN must not lock the operator out of their own
  // control panel.
  test("counts each address separately", () => {
    const { instance } = limiter();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) instance.fail("a");
    expect(instance.retryAfter("a")).toBeGreaterThan(0);
    expect(instance.retryAfter("b")).toBe(0);
  });

  // Fatfingering the password twice and then getting it right must not leave
  // those failures banked against a later lockout.
  test("a successful login clears the counter", () => {
    const { instance } = limiter();
    instance.fail("a");
    instance.fail("a");
    instance.succeed("a");
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      expect(instance.fail("a")).toBe(false);
    }
  });

  // Failures spread thinly must not accumulate forever into a lockout.
  test("failures older than the window do not count", () => {
    const { instance, advance } = limiter();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) instance.fail("a");
    advance(LOCKOUT_MS);
    expect(instance.fail("a")).toBe(false);
    expect(instance.retryAfter("a")).toBe(0);
  });

  // The lockout should run from the failure that tripped it.
  test("the lockout runs from the tripping failure, not the window start", () => {
    const { instance, advance } = limiter();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) instance.fail("a");
    advance(LOCKOUT_MS - 1000);
    instance.fail("a");
    expect(instance.retryAfter("a")).toBe(LOCKOUT_MS / 1000);
  });

  test("forgets addresses whose window has lapsed", () => {
    const { instance, advance } = limiter();
    instance.fail("stale");
    advance(LOCKOUT_MS + 1);
    instance.fail("fresh");
    // @ts-expect-error -- reaching into the private map to prove the sweep ran
    expect([...instance.records.keys()]).toEqual(["fresh"]);
  });
});
