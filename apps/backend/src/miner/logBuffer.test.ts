import { expect, test } from "vitest";
import { LogBuffer } from "./logBuffer.js";

test("keeps only the most recent lines", () => {
  const buffer = new LogBuffer(3);
  for (const line of ["a", "b", "c", "d"]) buffer.push(line);
  expect(buffer.lines()).toEqual(["b", "c", "d"]);
});

test("splits multi-line chunks", () => {
  const buffer = new LogBuffer(10);
  buffer.push("one\ntwo\n");
  expect(buffer.lines()).toEqual(["one", "two"]);
});

test("ignores empty lines", () => {
  const buffer = new LogBuffer(10);
  buffer.push("\n\n");
  expect(buffer.lines()).toEqual([]);
});
