import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PasswordGate } from "./PasswordGate.js";

afterEach(() => { vi.unstubAllGlobals(); });

function stubSequence(...statuses: number[]) {
  const queue = [...statuses];
  vi.stubGlobal("fetch", vi.fn(async () => {
    const status = queue.shift() ?? 200;
    return { ok: status < 300, status, json: async () => ({}) };
  }));
}

const ui = (
  <MantineProvider>
    <PasswordGate><div>secret content</div></PasswordGate>
  </MantineProvider>
);

// The label queries below match "Password" exactly, not /password/i.
// Mantine 9's PasswordInput renders a visibility toggle labelled "Toggle
// password visibility", so the loose regex matches two elements and
// throws. Keep these exact.

test("shows the password form when there is no session", async () => {
  stubSequence(401);
  render(ui);
  expect(await screen.findByLabelText("Password")).toBeInTheDocument();
  expect(screen.queryByText("secret content")).not.toBeInTheDocument();
});

test("renders children when a session already exists", async () => {
  stubSequence(200);
  render(ui);
  expect(await screen.findByText("secret content")).toBeInTheDocument();
});

test("unlocks after a successful login", async () => {
  stubSequence(401, 200, 200);
  render(ui);
  await userEvent.type(await screen.findByLabelText("Password"), "hunter2");
  await userEvent.click(screen.getByRole("button", { name: /unlock/i }));
  expect(await screen.findByText("secret content")).toBeInTheDocument();
});

test("shows an error on a wrong password and stays locked", async () => {
  stubSequence(401, 401);
  render(ui);
  await userEvent.type(await screen.findByLabelText("Password"), "wrong");
  await userEvent.click(screen.getByRole("button", { name: /unlock/i }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.queryByText("secret content")).not.toBeInTheDocument();
});

test("shows the brand mark above the unlock form", async () => {
  stubSequence(401);
  render(ui);
  expect(await screen.findByRole("img", { name: /miner control/i })).toBeInTheDocument();
});

test("re-locks when a session that was valid expires", async () => {
  stubSequence(200);
  render(
    <MantineProvider>
      <PasswordGate sessionExpired><div>secret content</div></PasswordGate>
    </MantineProvider>,
  );

  // The backend restarted and dropped every in-memory session, so the
  // content on screen is backed by a cookie the server no longer knows.
  await waitFor(() =>
    expect(screen.getByLabelText("Password")).toBeInTheDocument(),
  );
  expect(screen.queryByText("secret content")).not.toBeInTheDocument();
});

test("focuses the password field so the user can just type", async () => {
  stubSequence(401);
  render(ui);
  expect(await screen.findByLabelText("Password")).toHaveFocus();
});

test("keeps focus in the field after a wrong password", async () => {
  // The form remounts on each attempt to restart the shake animation,
  // which must not cost the user their cursor.
  stubSequence(401, 401);
  render(ui);
  await userEvent.type(await screen.findByLabelText("Password"), "nope");
  await userEvent.click(screen.getByRole("button", { name: /unlock/i }));
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.getByLabelText("Password")).toHaveFocus());
});
