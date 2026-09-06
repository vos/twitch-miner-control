import { readFileSync } from "node:fs";

export interface ProcSample {
  /**
   * Percent of one core used since the previous sample, or null when no
   * delta could be formed yet (first sample of a process, or two samples
   * taken at the same instant).
   */
  cpu: number | null;
  rssBytes: number;
}

export interface ProcStatsOptions {
  /** Injected so the tests can drive fixture text instead of a live process. */
  read?: (path: string) => string;
  pageSize?: number;
  clockTicks?: number;
}

/**
 * Linux reports CPU time in clock ticks; the kernel's user-space value
 * is fixed at 100Hz on every platform this ships to, and `getconf
 * CLK_TCK` confirmed it here. Node exposes no binding for it, so it is a
 * constant rather than a lookup.
 */
const CLOCK_TICKS = 100;

/** Matches getconf PAGESIZE on the container this ships in. */
const PAGE_SIZE = 4096;

/**
 * Reads CPU and memory for a single process out of /proc.
 *
 * Stateful by necessity: /proc/<pid>/stat reports CPU as a total
 * accumulated since the process started, so a *rate* only exists
 * relative to a previous reading. The instance holds the last sample and
 * reports the delta, which is why the status route keeps one of these
 * across polls rather than constructing one per request.
 *
 * Everything is best-effort. A missing or unreadable /proc entry -- a
 * miner that exited between the pid lookup and this read, or any
 * non-Linux dev machine -- yields null rather than throwing, because a
 * decorative header readout must never be able to fail the status route
 * that carries the miner's actual state.
 */
export class ProcStats {
  private readonly read: (path: string) => string;
  private readonly pageSize: number;
  private readonly clockTicks: number;
  private previous: { pid: number; ticks: number; at: number } | null = null;

  constructor(options: ProcStatsOptions = {}) {
    this.read = options.read ?? ((path) => readFileSync(path, "utf8"));
    this.pageSize = options.pageSize ?? PAGE_SIZE;
    this.clockTicks = options.clockTicks ?? CLOCK_TICKS;
  }

  sample(pid: number, now: number): ProcSample | null {
    let ticks: number;
    let rssBytes: number;
    try {
      ticks = this.readTicks(pid);
      rssBytes = this.readRss(pid);
    } catch {
      // Process gone, or no /proc at all. Drop any previous sample so a
      // later reading cannot form a delta spanning the gap.
      this.previous = null;
      return null;
    }

    const previous = this.previous;
    this.previous = { pid, ticks, at: now };

    // A different pid is a different process whose counters start from
    // zero, so there is nothing meaningful to diff against.
    if (previous === null || previous.pid !== pid) return { cpu: null, rssBytes };

    const elapsedMs = now - previous.at;
    if (elapsedMs <= 0) return { cpu: null, rssBytes };

    const cpuMs = ((ticks - previous.ticks) / this.clockTicks) * 1000;
    // Clamped at zero: a pid reused inside one poll interval would
    // present lower counters than the sample before it.
    return { cpu: Math.max(0, (cpuMs / elapsedMs) * 100), rssBytes };
  }

  private readTicks(pid: number): number {
    const line = this.read(`/proc/${pid}/stat`);
    // Field 2 is the executable name in parentheses and may itself
    // contain spaces and parentheses, so the numeric fields are counted
    // from after the LAST ')' rather than by splitting the whole line.
    const rest = line.slice(line.lastIndexOf(")") + 1).trim().split(/\s+/);
    // With comm and the fields before it removed, `rest` starts at field
    // 3 (state), so utime (field 14) and stime (field 15) sit at index
    // 11 and 12.
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) {
      throw new Error(`unparsable /proc/${pid}/stat`);
    }
    return utime + stime;
  }

  private readRss(pid: number): number {
    // statm's second field is resident pages -- cheaper to parse than
    // status's VmRSS and in pages rather than a unit-suffixed string.
    const pages = Number(this.read(`/proc/${pid}/statm`).trim().split(/\s+/)[1]);
    if (!Number.isFinite(pages)) throw new Error(`unparsable /proc/${pid}/statm`);
    return pages * this.pageSize;
  }
}
