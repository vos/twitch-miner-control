import { isAbsolute, resolve, sep } from "node:path";

/**
 * Resolves PYTHON_BIN to something `spawn` can find.
 *
 * The helpers and the miner all spawn with `cwd: dataDir`, so a relative
 * interpreter path from .env (`./.venv/bin/python`) would be resolved
 * against the data directory rather than the repo root and fail with
 * ENOENT. DATA_DIR, PYTHON_DIR and MINER_DIR are all passed through
 * `resolve()` at boot for the same reason; this keeps PYTHON_BIN
 * consistent with them.
 *
 * A bare command with no separator (`python3`, the default) is left
 * alone so it still goes through a normal PATH lookup.
 */
export function resolvePythonBin(value: string | undefined): string {
  const bin = value ?? "python3";
  if (isAbsolute(bin)) return bin;
  if (!bin.includes("/") && !bin.includes(sep)) return bin;
  return resolve(process.cwd(), bin);
}
