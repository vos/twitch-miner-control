import { describe, expect, test, vi } from "vitest";
import { UpdateChecker, isNewer } from "./updateCheck.js";

describe("isNewer", () => {
  test("reports a newer patch, minor and major release", () => {
    expect(isNewer("1.1.0", "1.1.1")).toBe(true);
    expect(isNewer("1.1.0", "1.2.0")).toBe(true);
    expect(isNewer("1.1.0", "2.0.0")).toBe(true);
  });

  test("reports nothing for the running version", () => {
    expect(isNewer("1.1.0", "1.1.0")).toBe(false);
  });

  test("reports nothing for an older release", () => {
    expect(isNewer("1.2.0", "1.1.9")).toBe(false);
    expect(isNewer("2.0.0", "1.9.9")).toBe(false);
  });

  test("compares each part as a number, not as text", () => {
    // "10" sorts before "9" as a string, which would hide every release
    // from 1.10.0 onwards.
    expect(isNewer("1.9.0", "1.10.0")).toBe(true);
    expect(isNewer("1.10.0", "1.9.0")).toBe(false);
  });

  test("tolerates a v prefix on either side", () => {
    expect(isNewer("v1.1.0", "v1.2.0")).toBe(true);
  });

  test("treats an unparseable version as not newer", () => {
    // A malformed or pre-release tag must never produce a notice: the
    // badge claims a specific upgrade exists, so anything we cannot read
    // with confidence degrades to silence.
    expect(isNewer("1.1.0", "nightly")).toBe(false);
    expect(isNewer("1.1.0", "1.2")).toBe(false);
    expect(isNewer("1.1.0", "1.2.0-rc.1")).toBe(false);
    expect(isNewer("dev", "1.2.0")).toBe(false);
    expect(isNewer("1.1.0", "")).toBe(false);
  });
});

/** A checker whose clock and network are both under the test's control. */
const checker = (current: string, fetchImpl: typeof fetch) =>
  new UpdateChecker({ current, fetchImpl });

const releaseResponse = (tag: unknown) =>
  ({ ok: true, json: async () => ({ tag_name: tag }) }) as Response;

describe("UpdateChecker", () => {
  test("offers nothing before the first check answers", () => {
    const c = checker("1.1.0", vi.fn());
    expect(c.available).toBeNull();
  });

  test("offers the release name once a newer one is published", async () => {
    const c = checker("1.1.0", vi.fn().mockResolvedValue(releaseResponse("v1.2.0")));
    await c.check();
    // Normalised: the badge renders this verbatim and the readout beside
    // it already writes its own "v".
    expect(c.available).toBe("1.2.0");
  });

  test("offers nothing when the published release is the running one", async () => {
    const c = checker("1.1.0", vi.fn().mockResolvedValue(releaseResponse("v1.1.0")));
    await c.check();
    expect(c.available).toBeNull();
  });

  test("never checks a dev build, which has no release to compare against", async () => {
    const fetchImpl = vi.fn();
    const c = checker("dev", fetchImpl);
    await c.check();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(c.available).toBeNull();
  });

  test("stays silent when GitHub cannot be reached", async () => {
    const c = checker("1.1.0", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    await expect(c.check()).resolves.toBeUndefined();
    expect(c.available).toBeNull();
  });

  test("stays silent when GitHub answers with an error status", async () => {
    // Rate limiting is the expected one: the API allows 60 requests an
    // hour per address, shared by everyone behind the same NAT.
    const c = checker("1.1.0", vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response));
    await c.check();
    expect(c.available).toBeNull();
  });

  test("stays silent on a malformed or unexpected body", async () => {
    const c = checker("1.1.0", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError("not json"); },
    } as unknown as Response));
    await c.check();
    expect(c.available).toBeNull();

    const missing = checker("1.1.0", vi.fn().mockResolvedValue(releaseResponse(undefined)));
    await missing.check();
    expect(missing.available).toBeNull();
  });

  test("forgets a previous offer once the running version catches up", async () => {
    // The notice has no dismiss button; upgrading is what clears it. A
    // stale offer surviving the upgrade would leave it stuck on forever.
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse("v1.2.0"));
    const c = checker("1.2.0", fetchImpl);
    await c.check();
    expect(c.available).toBeNull();
  });

  test("asks GitHub for the latest release of this repository", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse("v1.2.0"));
    await checker("1.1.0", fetchImpl).check();
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe("https://api.github.com/repos/vos/twitch-miner-control/releases/latest");
  });
});
