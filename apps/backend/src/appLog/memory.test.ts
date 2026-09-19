import { expect, test } from "vitest";
import { memoryLog } from "./memory.js";
import { NULL_LOG } from "./port.js";

test("records what was logged and at which level", () => {
  const log = memoryLog();
  log.info({ type: "a.thing", msg: "happened", count: 2 });
  log.warn({ type: "b.thing", msg: "went sideways" });
  expect(log.events).toEqual([
    { type: "a.thing", msg: "happened", count: 2, level: "info" },
    { type: "b.thing", msg: "went sideways", level: "warn" },
  ]);
});

test("a child stamps its component", () => {
  const log = memoryLog();
  log.child({ component: "drops" }).info({ type: "a.thing", msg: "happened" });
  expect(log.events[0]).toEqual({
    type: "a.thing", msg: "happened", level: "info", component: "drops",
  });
});

test("children share one ordered list with their parent", () => {
  // The sequence across components is the point: "pool rebuilt, THEN
  // restart proposed" is the interaction this feature exists to show,
  // and per-child arrays could not express it.
  const log = memoryLog();
  log.child({ component: "drops" }).info({ type: "pool.rebuilt", msg: "rebuilt" });
  log.child({ component: "miner" }).info({ type: "restart.proposed", msg: "proposed" });
  expect(log.events.map((e) => [e.component, e.type])).toEqual([
    ["drops", "pool.rebuilt"],
    ["miner", "restart.proposed"],
  ]);
});

test("a child of a child re-binds rather than nesting", () => {
  const log = memoryLog();
  log.child({ component: "drops" }).child({ component: "miner" })
    .info({ type: "a.thing", msg: "happened" });
  expect(log.events[0]?.component).toBe("miner");
});

test("ofType narrows to one event type", () => {
  const log = memoryLog();
  log.info({ type: "a.thing", msg: "one" });
  log.info({ type: "b.thing", msg: "two" });
  log.info({ type: "a.thing", msg: "three" });
  expect(log.ofType("a.thing").map((e) => e.msg)).toEqual(["one", "three"]);
});

test("the null log accepts everything and keeps nothing", () => {
  // Consumers fall back to this, so it must satisfy the same shape
  // without a call site ever needing to guard.
  expect(() => {
    NULL_LOG.debug({ type: "a", msg: "b" });
    NULL_LOG.info({ type: "a", msg: "b" });
    NULL_LOG.warn({ type: "a", msg: "b" });
    NULL_LOG.error({ type: "a", msg: "b" });
    NULL_LOG.child({ component: "drops" }).info({ type: "a", msg: "b" });
  }).not.toThrow();
});
