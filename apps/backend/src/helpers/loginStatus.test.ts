import { expect, test, vi } from "vitest";
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

test("signing out is announced only after being signed in", () => {
  const status = new LoginStatus();
  const heard = vi.fn();
  status.onSignedOut(heard);
  status.markLoggedOut(); // never signed in: a dead session at boot, not news
  expect(heard).not.toHaveBeenCalled();
  status.markLoggedIn();
  status.markLoggedOut();
  status.markLoggedOut(); // already out
  expect(heard).toHaveBeenCalledTimes(1);
});
