import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolvePythonBin } from "./pythonBin.js";

describe("resolvePythonBin", () => {
  test("resolves a relative path against the repo root, not the child's cwd", () => {
    // Helpers spawn with cwd: dataDir (e.g. ./.devdata), so a relative
    // PYTHON_BIN from .env would otherwise ENOENT.
    expect(resolvePythonBin("./.venv/bin/python")).toBe(
      resolve(process.cwd(), "./.venv/bin/python"),
    );
  });

  test("leaves a bare command alone so PATH lookup still works", () => {
    expect(resolvePythonBin("python3")).toBe("python3");
  });

  test("leaves an absolute path untouched", () => {
    expect(resolvePythonBin("/app/.venv/bin/python")).toBe("/app/.venv/bin/python");
  });

  test("defaults to python3 when unset", () => {
    expect(resolvePythonBin(undefined)).toBe("python3");
  });

  test("resolves a bare relative path containing a separator", () => {
    expect(resolvePythonBin("venv/bin/python")).toBe(
      resolve(process.cwd(), "venv/bin/python"),
    );
  });
});
