import { expect, test } from "vitest";
import { ProcStats } from "./procStats.js";

/** A /proc/<pid>/stat line, with utime (field 14) and stime (field 15) set. */
function statLine(comm: string, utime: number, stime: number): string {
  const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
  fields[10] = String(utime); // field 14, zero-indexed from field 4
  fields[11] = String(stime); // field 15
  return `42 (${comm}) S ${fields.join(" ")}`;
}

/** A /proc/<pid>/statm line; field 2 is resident pages. */
const statmLine = (pages: number) => `9999 ${pages} 731 154 0 186 0`;

function reader(files: Record<string, string>) {
  return (path: string) => {
    const body = files[path];
    if (body === undefined) throw new Error(`ENOENT: ${path}`);
    return body;
  };
}

test("reports memory from resident pages on the first sample", () => {
  const stats = new ProcStats({
    read: reader({
      "/proc/42/stat": statLine("python3", 0, 0),
      "/proc/42/statm": statmLine(1000),
    }),
    pageSize: 4096,
    clockTicks: 100,
  });

  // Memory is an instantaneous read, so it is available immediately --
  // unlike CPU, which needs a second sample to form a delta.
  expect(stats.sample(42, 0)?.rssBytes).toBe(4_096_000);
});

test("reports no cpu figure until a delta can be formed", () => {
  const stats = new ProcStats({
    read: reader({
      "/proc/42/stat": statLine("python3", 500, 100),
      "/proc/42/statm": statmLine(1000),
    }),
    pageSize: 4096,
    clockTicks: 100,
  });

  // One sample only gives the process's *cumulative* ticks since it
  // started. Reporting that as a percentage would be a lifetime average
  // that flatlines as uptime grows, not current usage.
  expect(stats.sample(42, 0)?.cpu).toBeNull();
});

test("computes cpu from the delta between two samples", () => {
  const files = {
    "/proc/42/stat": statLine("python3", 0, 0),
    "/proc/42/statm": statmLine(1000),
  };
  const stats = new ProcStats({
    read: reader(files),
    pageSize: 4096,
    clockTicks: 100,
  });

  stats.sample(42, 0);
  // 50 ticks of CPU at 100 ticks/sec is 0.5s of CPU, over 1s elapsed.
  files["/proc/42/stat"] = statLine("python3", 30, 20);
  expect(stats.sample(42, 1000)?.cpu).toBeCloseTo(50);
});

test("parses a process name containing spaces and parentheses", () => {
  const files = {
    "/proc/42/stat": statLine("py (thon) 3", 0, 0),
    "/proc/42/statm": statmLine(1000),
  };
  const stats = new ProcStats({
    read: reader(files),
    pageSize: 4096,
    clockTicks: 100,
  });

  stats.sample(42, 0);
  files["/proc/42/stat"] = statLine("py (thon) 3", 30, 20);
  // Splitting the whole line on whitespace would misalign every field
  // after the comm and read a nonsense number as utime.
  expect(stats.sample(42, 1000)?.cpu).toBeCloseTo(50);
});

test("starts a fresh delta when the pid changes", () => {
  const files = {
    "/proc/42/stat": statLine("python3", 9000, 9000),
    "/proc/42/statm": statmLine(1000),
    "/proc/43/stat": statLine("python3", 10, 10),
    "/proc/43/statm": statmLine(1000),
  };
  const stats = new ProcStats({
    read: reader(files),
    pageSize: 4096,
    clockTicks: 100,
  });

  stats.sample(42, 0);
  // A restarted miner is a new process whose counters start from zero.
  // Diffing them against the dead process's much larger totals would
  // yield a large negative delta and a nonsense percentage.
  expect(stats.sample(43, 1000)?.cpu).toBeNull();
});

test("reports nothing when the process is gone", () => {
  const stats = new ProcStats({
    read: reader({}),
    pageSize: 4096,
    clockTicks: 100,
  });

  // Also the non-Linux case: no /proc means the readout is simply
  // absent rather than the status route throwing.
  expect(stats.sample(42, 0)).toBeNull();
});

test("never reports a negative cpu figure", () => {
  const files = {
    "/proc/42/stat": statLine("python3", 500, 500),
    "/proc/42/statm": statmLine(1000),
  };
  const stats = new ProcStats({
    read: reader(files),
    pageSize: 4096,
    clockTicks: 100,
  });

  stats.sample(42, 0);
  // Defensive: a pid reused by a fresh process within one poll interval
  // would present lower counters than the sample before it.
  files["/proc/42/stat"] = statLine("python3", 1, 1);
  expect(stats.sample(42, 1000)?.cpu).toBe(0);
});

test("reports no cpu figure when no time has elapsed", () => {
  const files = {
    "/proc/42/stat": statLine("python3", 0, 0),
    "/proc/42/statm": statmLine(1000),
  };
  const stats = new ProcStats({
    read: reader(files),
    pageSize: 4096,
    clockTicks: 100,
  });

  stats.sample(42, 1000);
  files["/proc/42/stat"] = statLine("python3", 30, 20);
  // Dividing by a zero elapsed window would yield Infinity.
  expect(stats.sample(42, 1000)?.cpu).toBeNull();
});
