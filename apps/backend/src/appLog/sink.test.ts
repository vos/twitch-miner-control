import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LogSink, LOG_NAME, PREVIOUS_NAME, readTail } from "./sink.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "applog-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const line = (type: string, time = 1) =>
  `${JSON.stringify({ level: "info", time, type, msg: type })}\n`;

test("writes NDJSON lines to the log file", async () => {
  const sink = new LogSink({ dir, maxBytes: 1_000_000 });
  sink.write(line("a.thing"));
  sink.write(line("b.thing"));
  await sink.close();

  const written = readFileSync(join(dir, LOG_NAME), "utf8").trim().split("\n");
  expect(written).toHaveLength(2);
  expect(JSON.parse(written[0] as string)).toMatchObject({ type: "a.thing" });
});

test("creates the directory if it does not exist", async () => {
  const nested = join(dir, "logs");
  const sink = new LogSink({ dir: nested, maxBytes: 1_000_000 });
  sink.write(line("a.thing"));
  await sink.close();
  expect(existsSync(join(nested, LOG_NAME))).toBe(true);
});

test("rotates once past the cap", async () => {
  // A cap small enough that the second line trips it.
  const sink = new LogSink({ dir, maxBytes: Buffer.byteLength(line("a.thing")) + 1 });
  sink.write(line("a.thing"));
  sink.write(line("b.thing"));
  sink.write(line("c.thing"));
  await sink.close();

  expect(existsSync(join(dir, PREVIOUS_NAME))).toBe(true);
  // The rotated-out file holds the first two; the live one continues.
  const previous = readFileSync(join(dir, PREVIOUS_NAME), "utf8").trim().split("\n");
  expect(previous.map((l) => JSON.parse(l).type)).toEqual(["a.thing", "b.thing"]);
  const live = readFileSync(join(dir, LOG_NAME), "utf8").trim();
  expect(JSON.parse(live).type).toBe("c.thing");
});

test("only one previous generation is kept", async () => {
  // Two rotations: the first .1 must be replaced, not joined by a .2.
  const sink = new LogSink({ dir, maxBytes: Buffer.byteLength(line("a.thing")) + 1 });
  for (const type of ["a", "b", "c", "d", "e", "f"]) sink.write(line(type));
  await sink.close();

  expect(existsSync(join(dir, `${LOG_NAME}.2`))).toBe(false);
  // The kept previous generation is the most recent one rotated out, not
  // the oldest -- otherwise rotation would preserve ancient history and
  // discard what just happened.
  const previous = readFileSync(join(dir, PREVIOUS_NAME), "utf8").trim().split("\n");
  expect(previous.some((l) => JSON.parse(l).type === "a")).toBe(false);
});

test("an existing file is appended to, not truncated", async () => {
  const first = new LogSink({ dir, maxBytes: 1_000_000 });
  first.write(line("before.restart"));
  await first.close();

  const second = new LogSink({ dir, maxBytes: 1_000_000 });
  second.write(line("after.restart"));
  await second.close();

  const written = readFileSync(join(dir, LOG_NAME), "utf8").trim().split("\n");
  expect(written.map((l) => JSON.parse(l).type))
    .toEqual(["before.restart", "after.restart"]);
});

test("a write after close is dropped rather than thrown", async () => {
  // Shutdown closes the log while boot work may still be running; that
  // work's failure handler logs, and a throw there crashed the process.
  const sink = new LogSink({ dir, maxBytes: 1_000_000 });
  sink.write(line("before.close"));
  await sink.close();

  expect(() => sink.write(line("after.close"))).not.toThrow();
  const written = readFileSync(join(dir, LOG_NAME), "utf8").trim().split("\n");
  expect(written.map((l) => JSON.parse(l).type)).toEqual(["before.close"]);
});

test("the tail read returns events oldest first", async () => {
  const sink = new LogSink({ dir, maxBytes: 1_000_000 });
  sink.write(line("a.thing", 1));
  sink.write(line("b.thing", 2));
  await sink.close();

  expect(sink.readTail().map((e) => e.type)).toEqual(["a.thing", "b.thing"]);
});

test("a missing file reads as no history, not an error", () => {
  // First ever run: there is nothing to show, which is not a failure.
  expect(readTail(join(dir, "absent.ndjson"))).toEqual([]);
});

test("a torn line is skipped rather than throwing", () => {
  // What a hard kill mid-write leaves behind. Losing that one event is
  // survivable; throwing here would lose the whole log and the boot.
  const path = join(dir, LOG_NAME);
  writeFileSync(path, `${line("good.one")}{"level":"info","time":2,"typ\n${line("good.two")}`);
  expect(readTail(path).map((e) => e.type)).toEqual(["good.one", "good.two"]);
});

test("a line missing the envelope fields is skipped", () => {
  const path = join(dir, LOG_NAME);
  writeFileSync(path, `{"hello":"world"}\n${line("good.one")}`);
  expect(readTail(path).map((e) => e.type)).toEqual(["good.one"]);
});

test("a partial first line is dropped when the read starts mid-file", () => {
  // The tail window lands wherever it lands; the truncated line at its
  // start is not a real event and must not be reported as one.
  const path = join(dir, LOG_NAME);
  writeFileSync(path, line("old.one") + line("new.one"));
  const window = Buffer.byteLength(line("new.one")) + 5;
  expect(readTail(path, window).map((e) => e.type)).toEqual(["new.one"]);
});

test("reading the whole file keeps its first line", () => {
  // The complement of the case above: starting at byte 0 means the first
  // line is complete and dropping it would silently lose an event.
  const path = join(dir, LOG_NAME);
  writeFileSync(path, line("first.one") + line("second.one"));
  expect(readTail(path, 1_000_000).map((e) => e.type))
    .toEqual(["first.one", "second.one"]);
});

test("the built sink loads and rotates under plain Node", async () => {
  // Vitest's module interop is more forgiving than Node's: a named
  // import of sonic-boom typechecks and passes here, but throws "does
  // not provide an export named" in the real app. Likewise, an async
  // destination's flushSync() throws "not ready yet" and silently
  // dropped every buffered line on rotation and shutdown. Neither was
  // visible from inside vitest, so this runs the BUILT file the way the
  // app does and asserts the rotated generation actually holds its lines.
  const built = join(process.cwd(), "dist", "appLog", "sink.js");
  if (!existsSync(built)) return; // `pnpm test` without a build; nothing to check.

  const script = `
    import { mkdtempSync, readFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
    import { LogSink, LOG_NAME, PREVIOUS_NAME } from ${JSON.stringify(built)};
    const dir = mkdtempSync(join(tmpdir(), "built-"));
    const line = (t) => JSON.stringify({ level: "info", time: 1, type: t, msg: t }) + "\\n";
    const sink = new LogSink({ dir, maxBytes: Buffer.byteLength(line("a")) + 1 });
    sink.write(line("a")); sink.write(line("b")); sink.write(line("c"));
    await sink.close();
    process.stdout.write(JSON.stringify({
      previous: readFileSync(join(dir, PREVIOUS_NAME), "utf8").trim().split("\\n").length,
      live: readFileSync(join(dir, LOG_NAME), "utf8").trim().split("\\n").length,
    }));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd() },
  );
  // Two lines survived into the rotated file: proof flushSync worked.
  expect(JSON.parse(stdout)).toEqual({ previous: 2, live: 1 });
});
