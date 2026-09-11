/**
 * The repository whose releases the update notice is about. Hardcoded
 * rather than configurable: it names where *this* app is published, which
 * is a property of the build and not of a deployment. A fork that
 * publishes its own releases changes this line.
 */
const REPO = "vos/twitch-miner-control";

const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Strict `major.minor.patch`; anything else is deliberately unreadable. */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parse(version: string): [number, number, number] | null {
  const m = SEMVER.exec(version.trim());
  return m === null
    ? null
    : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Whether `latest` is a strictly newer release than `current`.
 *
 * Either side failing to parse answers false. The notice asserts that a
 * specific upgrade exists, so a pre-release tag, a `dev` build or a
 * malformed name has to degrade to silence rather than to a guess -- the
 * badge has no way to express "maybe".
 */
export function isNewer(current: string, latest: string): boolean {
  const a = parse(current);
  const b = parse(latest);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

export interface UpdateCheckerOptions {
  /** The running version, as resolved for `/api/status`. */
  current: string;
  /** Injected so tests never reach the network. */
  fetchImpl?: typeof fetch;
}

/**
 * Polls GitHub for the latest published release and remembers whether it
 * is newer than what this process is running.
 *
 * Every failure path is silent. This drives a decorative badge, so a
 * rate-limited, unreachable or malformed answer must leave the notice
 * absent rather than surface an error -- the same judgement `version.ts`
 * makes about an unreadable manifest.
 */
export class UpdateChecker {
  /** The newer release's version, or null when there is nothing to offer. */
  available: string | null = null;

  private readonly current: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ current, fetchImpl = fetch }: UpdateCheckerOptions) {
    this.current = current;
    this.fetchImpl = fetchImpl;
  }

  async check(): Promise<void> {
    // A dev build has no release to compare against, and telling someone
    // to upgrade their own working tree is noise. Skipping the request
    // also keeps `pnpm dev` off the network entirely.
    if (parse(this.current) === null) return;

    try {
      const res = await this.fetchImpl(LATEST_RELEASE_URL, {
        headers: { accept: "application/vnd.github+json" },
      });
      if (!res.ok) return;
      const body: unknown = await res.json();
      const tag = (body as { tag_name?: unknown }).tag_name;
      if (typeof tag !== "string") return;

      // Normalised, because the readout beside the badge writes its own
      // "v" and the API's tags carry one.
      this.available = isNewer(this.current, tag) ? tag.trim().replace(/^v/, "") : null;
    } catch {
      // Unreachable, rate-limited, or not JSON: leave the last answer be.
    }
  }
}
