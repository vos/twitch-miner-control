import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppLog } from "./pino.js";
import { LOG_NAME } from "./sink.js";
import type { AppLogEvent } from "./buffer.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "applog-pino-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const create = (over: Partial<Parameters<typeof createAppLog>[0]> = {}) =>
  createAppLog({ level: "info", dir, maxBytes: 1_000_000, ...over });

test("writes an event to the file as NDJSON", async () => {
  const handle = create();
  handle.log.info({ type: "a.thing", msg: "happened", count: 2 });
  await handle.close();

  const written = readFileSync(join(dir, LOG_NAME), "utf8").trim();
  expect(JSON.parse(written)).toMatchObject({
    level: "info", type: "a.thing", msg: "happened", count: 2,
  });
});

test("the level is a name, not pino's numeric code", async () => {
  // The file is meant to be read with jq and grep; `"level":30` is not
  // something a human should have to memorise.
  const handle = create();
  handle.log.warn({ type: "a.thing", msg: "happened" });
  await handle.close();
  expect(JSON.parse(readFileSync(join(dir, LOG_NAME), "utf8").trim()).level).toBe("warn");
});

test("pid and hostname are not written", async () => {
  const handle = create();
  handle.log.info({ type: "a.thing", msg: "happened" });
  await handle.close();
  const parsed = JSON.parse(readFileSync(join(dir, LOG_NAME), "utf8").trim());
  expect(parsed).not.toHaveProperty("pid");
  expect(parsed).not.toHaveProperty("hostname");
});

test("a child stamps its component on the file line", async () => {
  const handle = create();
  handle.log.child({ component: "drops" }).info({ type: "a.thing", msg: "happened" });
  await handle.close();
  expect(JSON.parse(readFileSync(join(dir, LOG_NAME), "utf8").trim()).component)
    .toBe("drops");
});

test("events land in the ring with a time", async () => {
  const handle = create();
  handle.log.info({ type: "a.thing", msg: "happened" });
  const entries = handle.buffer.entries();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ type: "a.thing", level: "info" });
  expect(typeof entries[0]?.time).toBe("number");
  await handle.close();
});

test("onEvent fires once per event", async () => {
  const seen: AppLogEvent[] = [];
  const handle = create({ onEvent: (e) => seen.push(e) });
  handle.log.info({ type: "a.thing", msg: "one" });
  handle.log.info({ type: "b.thing", msg: "two" });
  await handle.close();
  expect(seen.map((e) => e.type)).toEqual(["a.thing", "b.thing"]);
});

test("the ring and the file agree exactly", async () => {
  // The ring parses back what pino wrote rather than capturing the
  // object first, so the UI cannot drift from the file.
  const handle = create();
  handle.log.info({ type: "a.thing", msg: "happened", nested: { a: 1 } });
  const fromRing = handle.buffer.entries()[0];
  await handle.close();
  const fromFile = JSON.parse(readFileSync(join(dir, LOG_NAME), "utf8").trim());
  expect(fromRing).toEqual(fromFile);
});

test("an event below the level is not written", async () => {
  const handle = create({ level: "warn" });
  handle.log.info({ type: "a.thing", msg: "quiet" });
  handle.log.warn({ type: "b.thing", msg: "loud" });
  await handle.close();
  const lines = readFileSync(join(dir, LOG_NAME), "utf8").trim().split("\n");
  expect(lines.map((l) => JSON.parse(l).type)).toEqual(["b.thing"]);
});

test("the handle reports whether anything is being recorded", () => {
  // "Switched off" and "on but quiet" are both an empty list from the
  // outside; only this flag tells them apart, and the UI needs the
  // difference to avoid showing a blank panel that reads as broken.
  expect(create().enabled).toBe(true);
  expect(create({ level: "silent" }).enabled).toBe(false);
});

test("silent opens no file at all", async () => {
  const handle = create({ level: "silent" });
  handle.log.error({ type: "a.thing", msg: "not written" });
  await handle.close();
  // Not merely empty -- nothing is created, so a production box set to
  // silent costs no handle and no directory.
  expect(existsSync(join(dir, LOG_NAME))).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
  expect(handle.buffer.entries()).toEqual([]);
});

test("the ring is seeded from the file across a restart", async () => {
  // The advantage over the miner's buffer, which starts empty each boot:
  // an auto-restart is one of the moments you most want to look back at.
  const first = create();
  first.log.info({ type: "before.restart", msg: "happened" });
  await first.close();

  const second = create();
  expect(second.buffer.entries().map((e) => e.type)).toEqual(["before.restart"]);
  second.log.info({ type: "after.restart", msg: "happened" });
  expect(second.buffer.entries().map((e) => e.type))
    .toEqual(["before.restart", "after.restart"]);
  // Seeded events count as history, so the first live frame is not a gap.
  expect(second.buffer.total).toBe(2);
  await second.close();
});
