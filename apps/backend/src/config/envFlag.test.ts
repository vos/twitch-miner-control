import { describe, expect, test } from "vitest";
import { resolveEnvFlag } from "./envFlag.js";

describe("resolveEnvFlag", () => {
  // The documented deployment is plain HTTP on a LAN. A `secure` cookie
  // there is dropped by the browser, so defaulting to on would break login
  // for the setup the README tells people to use.
  test.each([undefined, "", "   "])("stays off when unset (%j)", (value) => {
    expect(resolveEnvFlag(value)).toBe(false);
  });

  test.each(["1", "true", "yes", "on", "TRUE", " true "])(
    "enables the flag for %j",
    (value) => {
      expect(resolveEnvFlag(value)).toBe(true);
    },
  );

  test.each(["0", "false", "no", "off", "OFF"])(
    "disables the flag for %j",
    (value) => {
      expect(resolveEnvFlag(value)).toBe(false);
    },
  );

  // Fails loud rather than quiet: a typo behind a proxy yields a visibly
  // broken login, not a cookie the operator wrongly believes is protected.
  test.each(["ture", "enabled", "maybe"])(
    "treats unrecognised value %j as enabled",
    (value) => {
      expect(resolveEnvFlag(value)).toBe(true);
    },
  );
});
