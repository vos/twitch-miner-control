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

test("shows the password form when there is no session", async () => {
  stubSequence(401);
  render(ui);
  expect(await screen.findByLabelText(/password/i)).toBeInTheDocument();
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
  await userEvent.type(await screen.findByLabelText(/password/i), "hunter2");
  await userEvent.click(screen.getByRole("button", { name: /unlock/i }));
  expect(await screen.findByText("secret content")).toBeInTheDocument();
});

test("shows an error on a wrong password and stays locked", async () => {
  stubSequence(401, 401);
  render(ui);
  await userEvent.type(await screen.findByLabelText(/password/i), "wrong");
  await userEvent.click(screen.getByRole("button", { name: /unlock/i }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.queryByText("secret content")).not.toBeInTheDocument();
});
