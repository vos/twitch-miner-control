import { expect, test } from "vitest";
import { ActionTokens } from "./actions.js";

const action = { kind: "cancel-restart" as const, dueAt: 5_000 };

test("a token redeems once", () => {
  const tokens = new ActionTokens(() => 1_000);
  const token = tokens.mint(action, 5_000);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(tokens.redeem(token)).toEqual(action);
  expect(tokens.redeem(token)).toBeNull();
});

test("an expired token redeems nothing", () => {
  let now = 1_000;
  const tokens = new ActionTokens(() => now);
  const token = tokens.mint(action, 5_000);
  now = 5_000;
  expect(tokens.redeem(token)).toBeNull();
});

test("an unknown or malformed token redeems nothing", () => {
  const tokens = new ActionTokens(() => 1_000);
  tokens.mint(action, 5_000);
  expect(tokens.redeem("0".repeat(64))).toBeNull();
  expect(tokens.redeem("not a token")).toBeNull();
});

test("two tokens are independent", () => {
  const tokens = new ActionTokens(() => 1_000);
  const a = tokens.mint(action, 5_000);
  const b = tokens.mint({ ...action, dueAt: 9_000 }, 9_000);
  expect(tokens.redeem(b)?.dueAt).toBe(9_000);
  expect(tokens.redeem(a)?.dueAt).toBe(5_000);
});
