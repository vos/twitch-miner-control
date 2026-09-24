import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Batcher, combine, listNames } from "./batcher.js";
import { NOTIFY_KIND, type Notification } from "./catalogue.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("a bucket flushes once, after the window, with everything that arrived", () => {
  const flush = vi.fn();
  const b = new Batcher<number>(10_000, flush);
  b.add("k", 1);
  vi.advanceTimersByTime(5_000);
  b.add("k", 2);
  expect(flush).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5_000);
  expect(flush).toHaveBeenCalledWith("k", [1, 2]);
  b.add("k", 3);
  vi.advanceTimersByTime(10_000);
  expect(flush).toHaveBeenLastCalledWith("k", [3]);
});

test("keys are batched separately", () => {
  const flush = vi.fn();
  const b = new Batcher<number>(1_000, flush);
  b.add("a", 1);
  b.add("b", 2);
  vi.advanceTimersByTime(1_000);
  expect(flush).toHaveBeenCalledWith("a", [1]);
  expect(flush).toHaveBeenCalledWith("b", [2]);
});

test("stop drops whatever is waiting", () => {
  const flush = vi.fn();
  const b = new Batcher<number>(1_000, flush);
  b.add("a", 1);
  b.stop();
  vi.advanceTimersByTime(1_000);
  expect(flush).not.toHaveBeenCalled();
});

const online = (login: string, ts: number): Notification => ({
  kind: NOTIFY_KIND.STREAMER_ONLINE, title: `${login} is live`, body: "Went live",
  ts, streamer: { login, name: login }, link: `/?open=dashboard&streamer=${login}`,
});

test("a single item passes through unchanged", () => {
  const n = online("alpha", 1);
  expect(combine([n])).toBe(n);
});

test("several streamers collapse into one summary", () => {
  const summary = combine(["alpha", "beta", "gamma", "delta"].map((l, i) => online(l, i)));
  expect(summary).toMatchObject({
    kind: "streamer.online",
    title: "4 streamers went live",
    body: "alpha, beta, gamma and 1 more",
    ts: 3,
    link: "/?open=dashboard",
  });
});

test("several drops collapse into one summary", () => {
  const drop = (body: string, ts: number): Notification => ({
    kind: NOTIFY_KIND.DROP_CLAIMED, title: "Drop claimed", body, ts, link: "/?open=drops",
  });
  expect(combine([drop("Claim A", 1), drop("Claim B", 2)])).toMatchObject({
    title: "2 drops claimed", body: "Claim A · Claim B", link: "/?open=drops",
  });
});

test("names read naturally at every length", () => {
  expect(listNames(["a"])).toBe("a");
  expect(listNames(["a", "b"])).toBe("a and b");
  expect(listNames(["a", "b", "c"])).toBe("a, b and c");
  expect(listNames(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
});
