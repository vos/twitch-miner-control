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

test("a rejected session is announced only after being signed in", () => {
  const status = new LoginStatus();
  const heard = vi.fn();
  status.onSignedOut(heard);
  status.markRejected(); // never signed in: a dead session at boot, not news
  expect(heard).not.toHaveBeenCalled();
  status.markLoggedIn();
  status.markRejected();
  status.markRejected(); // already out
  expect(heard).toHaveBeenCalledTimes(1);
});

test("markLoggedOut never announces, even after being signed in", () => {
  // The user asking to sign out is expected, not a `twitch.signedOut`-worthy
  // event -- only a rejected session (markRejected) should notify listeners.
  const status = new LoginStatus();
  const heard = vi.fn();
  status.onSignedOut(heard);
  status.markLoggedIn();
  status.markLoggedOut();
  expect(heard).not.toHaveBeenCalled();
  expect(status.required).toBe(true);
});
