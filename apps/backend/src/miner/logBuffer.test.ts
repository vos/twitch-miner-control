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

test("push reports the lines it kept", () => {
  const buffer = new LogBuffer(10);
  expect(buffer.push("one\n\ntwo\n")).toEqual(["one", "two"]);
});

test("counts every line ever kept, including ones since dropped", () => {
  // A reader holding this count can tell which pushed lines it already has,
  // and whether it missed any, even after the oldest have been evicted.
  const buffer = new LogBuffer(3);
  for (const line of ["a", "b", "c", "d"]) buffer.push(line);
  expect(buffer.total).toBe(4);
});
