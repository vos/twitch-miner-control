import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Logs } from "./Logs.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const view = () => render(<MantineProvider><Logs /></MantineProvider>);

test("renders log lines from the API", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ lines: ["hello", "world"] }),
  })));
  view();
  expect(await screen.findByText(/hello/)).toBeInTheDocument();
  expect(screen.getByText(/world/)).toBeInTheDocument();
});

// Correction 1: a failing /api/logs must not render a silently empty
// panel -- indistinguishable from "the miner logged nothing" -- because
// this panel is exactly where an operator looks to diagnose a crash.
test("surfaces a visible message when the log fetch fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false, status: 500, json: async () => ({ error: "disk on fire" }),
  })));
  view();
  expect(await screen.findByRole("alert")).toHaveTextContent(/disk on fire/i);
});

test("a subsequent successful poll clears a transient error", async () => {
  vi.useFakeTimers();
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    call += 1;
    if (call === 1) {
      return { ok: false, status: 500, json: async () => ({ error: "disk on fire" }) };
    }
    return { ok: true, status: 200, json: async () => ({ lines: ["recovered"] }) };
  }));

  render(<MantineProvider><Logs /></MantineProvider>);

  // First poll fails and the error banner appears.
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole("alert")).toHaveTextContent(/disk on fire/i);

  // Next poll succeeds; the banner must clear rather than persist forever.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText(/recovered/)).toBeInTheDocument();
});
