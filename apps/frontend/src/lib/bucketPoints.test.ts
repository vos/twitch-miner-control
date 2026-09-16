import { expect, test } from "vitest";
import { bucketPoints } from "./bucketPoints.js";

const HOUR = 3_600_000;

test("an empty series charts nothing", () => {
  expect(bucketPoints([], "24h", 0, 24 * HOUR)).toEqual([]);
});

test("a single sample charts one row with no gain", () => {
  // No earlier balance to difference against: the gain is unknown, and
  // reporting the balance itself as a gain would invent a huge one.
  const rows = bucketPoints([{ ts: HOUR, balance: 500 }], "24h", 0, 24 * HOUR);
  expect(rows).toEqual([{ ts: HOUR, balance: 500, gain: 0 }]);
});

test("gain is the difference from the previous bucket, not the balance", () => {
  const rows = bucketPoints(
    [{ ts: HOUR, balance: 100 }, { ts: 2 * HOUR, balance: 160 }],
    "24h", 0, 24 * HOUR,
  );
  expect(rows.map((r) => r.gain)).toEqual([0, 60]);
});

test("a flat stretch holds the balance rather than sloping to the next sample", () => {
  // Writes are change-only: nothing between these two timestamps means
  // the balance did not move, so every bucket between them carries the
  // earlier balance and a zero gain.
  const rows = bucketPoints(
    [{ ts: 0, balance: 100 }, { ts: 3 * HOUR, balance: 200 }],
    "24h", 0, 3 * HOUR,
  );
  const middle = rows.slice(0, -1);
  expect(middle.every((r) => r.balance === 100)).toBe(true);
  expect(middle.every((r) => r.gain === 0)).toBe(true);
  expect(rows[rows.length - 1]).toEqual({ ts: 3 * HOUR, balance: 200, gain: 100 });
});

test("samples inside one bucket collapse to the bucket's closing balance", () => {
  const rows = bucketPoints(
    [
      { ts: 0, balance: 100 },
      { ts: 60_000, balance: 120 },
      { ts: 120_000, balance: 140 },
    ],
    "30d", 0, 30 * 24 * HOUR,
  );
  expect(rows[0].balance).toBe(140);
});

test("a falling balance reports a negative gain", () => {
  const rows = bucketPoints(
    [{ ts: HOUR, balance: 500 }, { ts: 2 * HOUR, balance: 400 }],
    "24h", 0, 24 * HOUR,
  );
  expect(rows[rows.length - 1].gain).toBe(-100);
});

test("samples outside the window are excluded", () => {
  const rows = bucketPoints(
    [{ ts: 0, balance: 50 }, { ts: 10 * HOUR, balance: 90 }],
    "24h", 5 * HOUR, 24 * HOUR,
  );
  expect(rows.every((r) => r.ts >= 5 * HOUR)).toBe(true);
});
