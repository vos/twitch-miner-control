import { expect, test } from "vitest";
import { AppLogBuffer, type AppLogEvent } from "./buffer.js";

const event = (type: string, time = 1): AppLogEvent =>
  ({ type, msg: type, level: "info", time });

test("keeps what it is given, in order", () => {
  const buffer = new AppLogBuffer();
  buffer.push(event("a"));
  buffer.push(event("b"));
  expect(buffer.entries().map((e) => e.type)).toEqual(["a", "b"]);
});

test("evicts the oldest past capacity", () => {
  const buffer = new AppLogBuffer(2);
  buffer.push(event("a"));
  buffer.push(event("b"));
  buffer.push(event("c"));
  expect(buffer.entries().map((e) => e.type)).toEqual(["b", "c"]);
});

test("total counts evicted events too", () => {
  // This is what lets a reader tell "I have everything" from "events went
  // by while I was away"; capping it at the capacity would hide gaps.
  const buffer = new AppLogBuffer(2);
  buffer.push(event("a"));
  buffer.push(event("b"));
  buffer.push(event("c"));
  expect(buffer.total).toBe(3);
  expect(buffer.entries()).toHaveLength(2);
});

test("seeded events count as history, not as new", () => {
  const buffer = new AppLogBuffer();
  buffer.seed([event("a"), event("b")]);
  expect(buffer.total).toBe(2);
  expect(buffer.entries().map((e) => e.type)).toEqual(["a", "b"]);
});

test("entries are a copy, so a reader cannot mutate the ring", () => {
  const buffer = new AppLogBuffer();
  buffer.push(event("a"));
  buffer.entries().push(event("b"));
  expect(buffer.entries()).toHaveLength(1);
});
