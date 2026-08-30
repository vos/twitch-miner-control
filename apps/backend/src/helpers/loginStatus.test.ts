import { expect, test } from "vitest";
import { LoginStatus } from "./loginStatus.js";

test("a session is required by default, before anything has reported in", () => {
  expect(new LoginStatus().required).toBe(true);
});

test("markLoggedIn clears the requirement", () => {
  const status = new LoginStatus();
  status.markLoggedIn();
  expect(status.required).toBe(false);
});

test("markLoggedOut re-imposes the requirement after a login", () => {
  const status = new LoginStatus();
  status.markLoggedIn();
  status.markLoggedOut();
  expect(status.required).toBe(true);
});

test("markLoggedOut is a safe no-op when nothing was ever logged in", () => {
  const status = new LoginStatus();
  status.markLoggedOut();
  expect(status.required).toBe(true);
});
