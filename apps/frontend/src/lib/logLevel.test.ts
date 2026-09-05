import { expect, test } from "vitest";
import { levelOf } from "./logLevel.js";

test("classifies errors", () => {
  expect(levelOf("2026-09-05 12:00:00 - ERROR - websocket closed")).toBe("error");
});

test("classifies warnings", () => {
  expect(levelOf("2026-09-05 12:00:00 - WARNING - retrying in 5s")).toBe("warn");
});

test("classifies a points gain, which is the line worth spotting", () => {
  expect(levelOf("12:00:00 - INFO - +50 -> forsen (WATCH)")).toBe("gain");
});

test("falls back to info", () => {
  expect(levelOf("12:00:00 - INFO - starting")).toBe("info");
});

test("is not fooled by the word error inside a message body", () => {
  // Only the level field decides; otherwise a channel called "errorbot"
  // would paint every one of its lines red.
  expect(levelOf("12:00:00 - INFO - watching errorbot")).toBe("info");
});

test("lets debug noise recede", () => {
  // A real quiet run is almost entirely DEBUG; it must not compete with
  // the lines an operator is actually scanning for.
  expect(levelOf("05/09/26 12:18:17 - DEBUG - urllib3 - [_new_conn]: Starting")).toBe("debug");
});
