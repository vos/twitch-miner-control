import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EventsFeed } from "./EventsFeed.js";

function stub(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok, status: ok ? 200 : 500, json: async () => body,
  })));
}

afterEach(() => vi.unstubAllGlobals());

const view = () => render(<MantineProvider><EventsFeed /></MantineProvider>);

test("renders events as readable labels rather than raw enum names", async () => {
  stub({ events: [{ ts: Date.now(), type: "STREAMER_ONLINE" }] });
  view();
  expect(await screen.findByText(/streamer online/i)).toBeInTheDocument();
});

test("says so when nothing has happened yet", async () => {
  stub({ events: [] });
  view();
  expect(await screen.findByText(/no activity yet/i)).toBeInTheDocument();
});

test("stays silent when the feed cannot be loaded", async () => {
  // The feed is ancillary; a failure must not put an error banner on the
  // dashboard beside perfectly good numbers.
  stub({ error: "boom" }, false);
  const { container } = view();
  await new Promise((r) => setTimeout(r, 0));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
