import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { UNKNOWN_VERSION, resolveVersion } from "./version.js";

let dir: string;
let manifest: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ver-"));
  manifest = join(dir, "package.json");
});

const write = (contents: string) => writeFileSync(manifest, contents, "utf8");

describe("resolveVersion", () => {
  test("prefers APP_VERSION, the only source the container has", () => {
    write(JSON.stringify({ version: "9.9.9" }));
    expect(resolveVersion("1.1.0", manifest)).toBe("1.1.0");
  });

  test("falls back to the manifest so dev shows a real version", () => {
    write(JSON.stringify({ version: "1.1.0" }));
    expect(resolveVersion(undefined, manifest)).toBe("1.1.0");
  });

  test("treats an empty or blank APP_VERSION as unset", () => {
    write(JSON.stringify({ version: "1.1.0" }));
    expect(resolveVersion("", manifest)).toBe("1.1.0");
    expect(resolveVersion("   ", manifest)).toBe("1.1.0");
  });

  test("reports the unknown version when there is no manifest", () => {
    expect(resolveVersion(undefined, join(dir, "absent.json"))).toBe(UNKNOWN_VERSION);
  });

  test("never throws on a corrupt manifest", () => {
    write("{not json");
    expect(resolveVersion(undefined, manifest)).toBe(UNKNOWN_VERSION);
  });

  test("ignores a manifest with no usable version field", () => {
    write(JSON.stringify({ name: "twitch-miner-control" }));
    expect(resolveVersion(undefined, manifest)).toBe(UNKNOWN_VERSION);
    write(JSON.stringify({ version: 11 }));
    expect(resolveVersion(undefined, manifest)).toBe(UNKNOWN_VERSION);
    write(JSON.stringify({ version: "  " }));
    expect(resolveVersion(undefined, manifest)).toBe(UNKNOWN_VERSION);
  });

  test("trims a version that arrives with stray whitespace", () => {
    expect(resolveVersion(" 1.1.0\n", manifest)).toBe("1.1.0");
  });
});
