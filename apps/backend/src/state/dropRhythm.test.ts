import { expect, test } from "vitest";
import { dropRhythm } from "./dropRhythm.js";
import type { GameActivity } from "./campaignCatalogue.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-29T12:00:00.000Z");

/** Past campaigns starting `ago` days before NOW, each running two days. */
const past = (...ago: number[]): GameActivity => ({
  lastEndedAt: NOW - Math.min(...ago) * DAY + 2 * DAY,
  past: ago.map((d) => ({ startsAt: NOW - d * DAY, endsAt: NOW - d * DAY + 2 * DAY })),
});

test("reads a weekly game as every seven days", () => {
  expect(dropRhythm(past(3, 10, 17, 24, 31, 38), [], NOW).everyDays).toBe(7);
});

test("says nothing of a game whose gaps vary too much to call a rhythm", () => {
  // A made-up schedule is worse than none: it promises a campaign that
  // may be months away.
  expect(dropRhythm(past(2, 4, 40, 41, 120, 300), [], NOW).everyDays).toBeNull();
});

test("needs five campaigns before it calls anything a rhythm", () => {
  expect(dropRhythm(past(3, 10, 17, 24), [], NOW).everyDays).toBeNull();
});

test("counts campaigns opening the same day once", () => {
  // Parts of one event open together; read as separate starts they make
  // a weekly game look like it runs every three days.
  const a = past(3, 10, 17, 24, 31);
  const doubled: GameActivity = {
    ...a,
    past: [...a.past!, ...a.past!.map((w) => ({ ...w, startsAt: w.startsAt + 3_600_000 }))],
  };
  expect(dropRhythm(doubled, [], NOW).everyDays).toBe(7);
});

test("drops the rhythm of a game that has gone quiet", () => {
  // Weekly until three months ago: "usually every week" would be wrong.
  expect(dropRhythm(past(90, 97, 104, 111, 118, 125), [], NOW).everyDays).toBeNull();
});

test("counts the campaigns running now", () => {
  // Only four past starts, but the one running is the fifth.
  const out = dropRhythm(past(10, 17, 24, 31), [{ startsAt: NOW - 3 * DAY }], NOW);
  expect(out.everyDays).toBe(7);
});

test("reads only the recent rhythm of a long history", () => {
  // Monthly once, weekly lately: the last twelve gaps decide.
  const weekly = Array.from({ length: 13 }, (_, i) => 3 + i * 7);
  const monthly = Array.from({ length: 10 }, (_, i) => 120 + i * 30);
  expect(dropRhythm(past(...weekly, ...monthly), [], NOW).everyDays).toBe(7);
});

test("reports when the last campaign ended", () => {
  expect(dropRhythm(past(10, 17), [], NOW).lastEndedAt).toBe(NOW - 8 * DAY);
});

test("knows nothing of a game the tracker never listed", () => {
  expect(dropRhythm(undefined, [], NOW)).toEqual({ lastEndedAt: null, everyDays: null });
});

test("gives no rhythm for a game whose history was not read", () => {
  // The index knows when it last ran; only its page has the dates.
  expect(dropRhythm({ lastEndedAt: NOW - DAY }, [], NOW))
    .toEqual({ lastEndedAt: NOW - DAY, everyDays: null });
});
