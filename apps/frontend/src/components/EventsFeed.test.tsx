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

test("stays silent when a 200 carries the wrong shape", async () => {
  // The dashboard stubs one fetch for every URL, so this panel can be
  // handed a payload with no `events` key. That must not crash the page.
  stub({ streamers: [], lastUpdated: 1 });
  view();
  await new Promise((r) => setTimeout(r, 0));
  // MantineProvider injects <style> tags, so assert on the feed's own
  // content rather than an empty container.
  expect(screen.queryByText(/recent activity/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/no activity yet/i)).not.toBeInTheDocument();
});
