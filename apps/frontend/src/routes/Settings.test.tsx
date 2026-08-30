import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Settings } from "./Settings.js";

const config = {
  version: 1, username: "alex", followers: false, followersOrder: "ASC",
  defaults: {}, streamers: [],
};
let calls: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/config" && (!init || init.method === "GET")) {
      return { ok: true, status: 200, json: async () => config };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const view = () => render(<MantineProvider><Settings /></MantineProvider>);

test("shows the current followers setting", async () => {
  view();
  expect(await screen.findByLabelText(/mine my followed channels/i)).not.toBeChecked();
});

test("toggling followers stages a change rather than applying it", async () => {
  view();
  await userEvent.click(await screen.findByLabelText(/mine my followed channels/i));
  expect(await screen.findByTestId("pending-bar")).toBeInTheDocument();
  expect(calls.some((c) => c.url === "/api/config/apply")).toBe(false);
});

test("apply saves the new followers value and restarts", async () => {
  view();
  await userEvent.click(await screen.findByLabelText(/mine my followed channels/i));
  await userEvent.click(await screen.findByRole("button", { name: /apply & restart/i }));
  await waitFor(() => {
    const put = calls.find((c) => c.url === "/api/config" && c.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body)).followers).toBe(true);
    expect(calls.some((c) => c.url === "/api/config/apply")).toBe(true);
  });
});

test("changing follower order stages a change", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByLabelText(/newest first/i));
  expect(await screen.findByTestId("pending-bar")).toBeInTheDocument();
});
