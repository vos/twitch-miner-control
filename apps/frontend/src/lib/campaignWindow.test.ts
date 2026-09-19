import { expect, test } from "vitest";
import { narrowerWindow, windowLines } from "./campaignWindow.js";

const NOW = Date.parse("2026-09-19T12:00:00Z");
const day = 86_400_000;

test("reports both dates and how long a running campaign has been open", () => {
  const { rows, state } = windowLines(NOW - 4 * day, NOW + 4 * day, NOW);
  expect(rows.map((r) => r.label)).toEqual(["Starts", "Ends"]);
  expect(state).toBe("started 4d ago");
});

test("a campaign that has not opened counts down to its start", () => {
  // "started ... ago" on an unopened campaign is a claim about time you
  // could have been earning it.
  expect(windowLines(NOW + 2 * day, NOW + 9 * day, NOW).state)
    .toBe("opens in 2d");
});

test("an ended campaign says so in the past tense", () => {
  expect(windowLines(NOW - 9 * day, NOW - 3 * day, NOW).state)
    .toBe("ended 3d ago");
});

test("a campaign missing its start omits that row", () => {
  const { rows, state } = windowLines(null, NOW + 4 * day, NOW);
  expect(rows.map((r) => r.label)).toEqual(["Ends"]);
  // With no start there is nothing to measure elapsed time against.
  expect(state).toBeNull();
});

test("a campaign with no dates at all produces nothing to show", () => {
  expect(windowLines(null, null, NOW)).toEqual({ rows: [], state: null });
});

test("the dates carry a time, not just a day", () => {
  // A campaign ending at 09:59 versus 23:59 is most of a day apart, and
  // the countdown rounds that away.
  const { rows } = windowLines(NOW - day, NOW + day, NOW);
  expect(rows[1].value).toMatch(/\d{2}:\d{2}/);
});

test("values carry no padding -- the panel lays them out", () => {
  // Padded strings were a terminal idiom that fought the theme's type.
  const { rows } = windowLines(NOW - day, NOW + day, NOW);
  for (const r of rows) {
    expect(r.value).toBe(r.value.trim());
    expect(r.label).toBe(r.label.trim());
  }
});

const CS = NOW - 10 * day;
const CE = NOW + 10 * day;

test("a drop repeating its campaign's window has nothing of its own to show", () => {
  // Every drop in the live catalogue does this; showing it would print
  // the same dates on every tile.
  expect(narrowerWindow({ startsAt: CS, endsAt: CE }, CS, CE)).toBeNull();
});

test("a drop opening later than its campaign reports its own window", () => {
  const w = narrowerWindow({ startsAt: NOW, endsAt: CE }, CS, CE);
  expect(w).toEqual({ startsAt: NOW, endsAt: CE });
});

test("a drop closing earlier than its campaign reports its own window", () => {
  const w = narrowerWindow({ startsAt: CS, endsAt: NOW }, CS, CE);
  expect(w).toEqual({ startsAt: CS, endsAt: NOW });
});

test("a drop with no dates of its own shows nothing", () => {
  expect(narrowerWindow({}, CS, CE)).toBeNull();
  expect(narrowerWindow({ startsAt: null, endsAt: null }, CS, CE)).toBeNull();
});

test("a drop running wider than its campaign is not a narrower window", () => {
  // Inconsistent source data, not a sub-window: the campaign's own
  // dates still bound what can be earned.
  expect(narrowerWindow({ startsAt: CS - day, endsAt: CE + day }, CS, CE))
    .toBeNull();
});

