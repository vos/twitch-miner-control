import { expect, test } from "vitest";
import { bucketPoints } from "./bucketPoints.js";

const HOUR = 3_600_000;
// Local times, whatever the machine's zone: buckets sit on local hours
// and midnights, so epoch-relative fixtures would shift with the zone.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).getTime();

test("an empty series charts nothing", () => {
  expect(bucketPoints([], "24h", at(16, 0), at(17, 0))).toEqual([]);
});

test("24h buckets sit on whole hours, not on the first sample", () => {
  const rows = bucketPoints(
    [{ ts: at(16, 13, 27), balance: 100 }, { ts: at(16, 14, 40), balance: 160 }],
    "24h", at(16, 0), at(16, 15, 10),
  );
  expect(rows.map((r) => r.ts)).toEqual([at(16, 13), at(16, 14), at(16, 15)]);
});

test("7d buckets are local calendar days", () => {
  const rows = bucketPoints(
    [{ ts: at(14, 21), balance: 100 }, { ts: at(15, 1), balance: 150 }],
    "7d", at(10, 0), at(16, 12),
  );
  expect(rows.map((r) => r.ts)).toEqual([at(14, 0), at(15, 0), at(16, 0)]);
  // The 01:00 sample is the 15th's, not the 14th's evening.
  expect(rows.map((r) => r.gain)).toEqual([0, 50, 0]);
});

test("the chart runs to the end of the window, flat after the last sample", () => {
  // Writes are change-only: a channel quiet since 10:00 still has a
  // balance at 14:00 -- the same one.
  const rows = bucketPoints(
    [{ ts: at(16, 10, 5), balance: 100 }],
    "24h", at(16, 0), at(16, 14, 30),
  );
  expect(rows).toHaveLength(5);
  expect(rows.every((r) => r.balance === 100 && r.gain === 0)).toBe(true);
});

test("a single sample charts no gain", () => {
  // No earlier balance to difference against: reporting the balance
  // itself as a gain would invent a huge one.
  const rows = bucketPoints([{ ts: at(16, 1), balance: 500 }], "24h", at(16, 0), at(16, 1, 30));
  expect(rows).toEqual([{ ts: at(16, 1), balance: 500, gain: 0 }]);
});

test("gain is the difference from the previous bucket, not the balance", () => {
  const rows = bucketPoints(
    [{ ts: at(16, 1), balance: 100 }, { ts: at(16, 2), balance: 160 }],
    "24h", at(16, 0), at(16, 2, 30),
  );
  expect(rows.map((r) => r.gain)).toEqual([0, 60]);
});

test("the first bucket counts what it earned after its first sample", () => {
  const rows = bucketPoints(
    [{ ts: at(16, 1, 5), balance: 100 }, { ts: at(16, 1, 50), balance: 130 }],
    "24h", at(16, 0), at(16, 1, 55),
  );
  expect(rows).toEqual([{ ts: at(16, 1), balance: 130, gain: 30 }]);
});

test("a flat stretch holds the balance rather than sloping to the next sample", () => {
  const rows = bucketPoints(
    [{ ts: at(16, 0), balance: 100 }, { ts: at(16, 3), balance: 200 }],
    "24h", at(16, 0), at(16, 3),
  );
  const middle = rows.slice(0, -1);
  expect(middle.every((r) => r.balance === 100)).toBe(true);
  expect(middle.every((r) => r.gain === 0)).toBe(true);
  expect(rows[rows.length - 1]).toEqual({ ts: at(16, 3), balance: 200, gain: 100 });
});

test("samples inside one bucket collapse to the bucket's closing balance", () => {
  const rows = bucketPoints(
    [
      { ts: at(16, 9), balance: 100 },
      { ts: at(16, 9, 1), balance: 120 },
      { ts: at(16, 9, 2), balance: 140 },
    ],
    "30d", at(1, 0), at(16, 12),
  );
  expect(rows[0].balance).toBe(140);
});

test("a falling balance reports a negative gain", () => {
  const rows = bucketPoints(
    [{ ts: at(16, 1), balance: 500 }, { ts: at(16, 2), balance: 400 }],
    "24h", at(16, 0), at(16, 2, 30),
  );
  expect(rows[rows.length - 1].gain).toBe(-100);
});

test("samples outside the window are excluded", () => {
  const rows = bucketPoints(
    [{ ts: at(16, 0), balance: 50 }, { ts: at(16, 10), balance: 90 }],
    "24h", at(16, 5), at(16, 12),
  );
  expect(rows[0]).toEqual({ ts: at(16, 10), balance: 90, gain: 0 });
});

test("a day bucket across a DST change still starts at midnight", () => {
  // Europe's autumn change: the 25th of October 2026 is 25 hours long.
  const rows = bucketPoints(
    [{ ts: new Date(2026, 9, 24, 12).getTime(), balance: 1 }],
    "7d", new Date(2026, 9, 20).getTime(), new Date(2026, 9, 27, 12).getTime(),
  );
  expect(rows.every((r) => new Date(r.ts).getHours() === 0)).toBe(true);
  expect(rows).toHaveLength(4);
});
