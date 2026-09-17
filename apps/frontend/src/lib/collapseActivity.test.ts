import { expect, test } from "vitest";
import { collapseActivity } from "./collapseActivity.js";

const at = (min: number) => new Date(2026, 8, 17, 10, min).getTime();
const ev = (type: string, min: number, message: string | null = null) =>
  ({ ts: at(min), type, message });

test("leaves a list with no repeats alone", () => {
  const rows = collapseActivity([
    ev("STREAMER_ONLINE", 30), ev("WATCH_STREAK_PROGRESS", 29),
  ]);
  expect(rows.map((r) => r.count)).toEqual([1, 1]);
});

test("folds a run of the same event into one row carrying the count", () => {
  const rows = collapseActivity([
    ev("STREAMER_OFFLINE", 30), ev("STREAMER_OFFLINE", 20), ev("STREAMER_OFFLINE", 10),
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0].count).toBe(3);
});

test("keeps the newest timestamp of a run", () => {
  // The list is newest first and the run's head is what the reader is
  // looking at; dating the row from its oldest member would push a
  // fifteen-minute-old row to the bottom of the hour.
  const rows = collapseActivity([
    ev("STREAMER_OFFLINE", 30), ev("STREAMER_OFFLINE", 10),
  ]);
  expect(rows[0].ts).toBe(at(30));
});

test("a run broken by a different event starts a new run", () => {
  const rows = collapseActivity([
    ev("STREAMER_OFFLINE", 40), ev("STREAMER_OFFLINE", 35),
    ev("STREAMER_ONLINE", 30),
    ev("STREAMER_OFFLINE", 25), ev("STREAMER_OFFLINE", 20),
  ]);
  expect(rows.map((r) => r.count)).toEqual([2, 1, 2]);
});

test("sums the points a run earned", () => {
  // Three ten-point watch gains are thirty points. Reporting one of them
  // and hiding the rest would make the feed disagree with the balance.
  const gain = (min: number) =>
    ev("GAIN_FOR_WATCH", min, `+10 → Streamer(username=a) - Reason: WATCH.`);
  const rows = collapseActivity([gain(30), gain(20), gain(10)]);
  expect(rows).toHaveLength(1);
  expect(rows[0].count).toBe(3);
  expect(rows[0].earned).toBe(30);
});

test("a run of pointless events earns null, not zero", () => {
  // "+0" would claim the miner earned nothing from something that was
  // never about points in the first place.
  const rows = collapseActivity([ev("STREAMER_OFFLINE", 30), ev("STREAMER_OFFLINE", 20)]);
  expect(rows[0].earned).toBeNull();
});

test("events of one type with differing amounts still fold, and sum", () => {
  // The label is what the reader sees repeated, and it comes from the
  // type -- so two claims of different sizes are still "claim ×2".
  const rows = collapseActivity([
    ev("GAIN_FOR_CLAIM", 30, "+50 → Streamer(username=a) - Reason: CLAIM."),
    ev("GAIN_FOR_CLAIM", 20, "+10 → Streamer(username=a) - Reason: CLAIM."),
  ]);
  expect(rows[0].count).toBe(2);
  expect(rows[0].earned).toBe(60);
});

test("carries the label and the first message through", () => {
  const rows = collapseActivity([ev("STREAMER_OFFLINE", 30)]);
  expect(rows[0].label).toBe("streamer offline");
});
