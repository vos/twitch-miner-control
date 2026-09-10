import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Reported when neither the env var nor a readable manifest supplies one. */
export const UNKNOWN_VERSION = "dev";

/**
 * The application version, for `/api/status` and the header readout.
 *
 * `APP_VERSION` comes first because it is the only source that works in
 * the published image: docker/Dockerfile copies just the backend's `dist`
 * and `node_modules` plus the frontend build, so the root package.json --
 * the version's source of truth -- never lands in the container. Reading
 * the manifest alone would therefore be right on a dev machine and blank
 * for every user, which is the worst way for this to fail. The release
 * workflow reads the manifest and passes it in as a build arg.
 *
 * The manifest read is the dev fallback, so `pnpm dev` shows the real
 * version without anyone exporting anything.
 */
export function resolveVersion(
  env: string | undefined,
  manifestPath: string = defaultManifestPath(),
): string {
  const fromEnv = (env ?? "").trim();
  if (fromEnv !== "") return fromEnv;

  const fromManifest = readManifestVersion(manifestPath);
  return fromManifest ?? UNKNOWN_VERSION;
}

/**
 * Never throws: a missing, unreadable or malformed manifest degrades to
 * the unknown version. A decorative readout must not be able to take the
 * whole server down at boot.
 */
function readManifestVersion(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const version = (raw as { version?: unknown }).version;
    return typeof version === "string" && version.trim() !== ""
      ? version.trim()
      : null;
  } catch {
    return null;
  }
}

/** The workspace root manifest, relative to this file's build output. */
function defaultManifestPath(): string {
  // dist/config/version.js -> repo root is four levels up.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "package.json");
}
