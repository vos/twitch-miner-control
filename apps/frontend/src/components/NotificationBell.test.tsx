import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderLive } from "../test-utils.js";
import { NotificationBell } from "./NotificationBell.js";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  handlers = new Map<string, (event: MessageEvent) => void>();
  constructor() { FakeEventSource.last = this; }
  addEventListener(type: string, handler: (event: MessageEvent) => void) { this.handlers.set(type, handler); }
  close() {}
  push(type: string, data: unknown) {
    act(() => this.handlers.get(type)?.({ data: JSON.stringify(data) } as MessageEvent));
  }
}

const item = (id: number, title = `Item ${id}`) => ({
  id, ts: Date.now() - 60_000, kind: "drop.claimed", title, body: `Body ${id}`, streamer: null,
  link: `/?open=drops&campaign=c${id}`,
});

let inbox: ReturnType<typeof item>[];
let calls: string[];

beforeEach(() => {
  inbox = [item(3), item(2), item(1)];
  calls = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const body = url.startsWith("/api/notify/inbox")
      ? { items: url.includes("before=") ? [item(0, "Older")] : inbox }
      : { streamers: [], lastUpdated: null, stale: true, error: null };
    return { ok: true, status: 200, json: async () => body };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const view = (onOpenLink = vi.fn(), onOpenSettings = vi.fn()) => {
  renderLive(<NotificationBell onOpenLink={onOpenLink} onOpenSettings={onOpenSettings} />);
  return { onOpenLink, onOpenSettings };
};

test("a first visit starts with nothing unread", async () => {
  view();
  await waitFor(() => expect(localStorage.getItem("tw.notify.lastSeenId")).toBe("3"));
  expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
});

test("a non-finite stored value is treated as a first visit, not a badge stuck forever", async () => {
  localStorage.setItem("tw.notify.lastSeenId", "not-a-number");
  view();
  await waitFor(() => expect(localStorage.getItem("tw.notify.lastSeenId")).toBe("3"));
  expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
});

test("rows newer than the last seen count as unread, and pushed ones add to it", async () => {
  localStorage.setItem("tw.notify.lastSeenId", "1");
  view();
  expect(await screen.findByRole("button", { name: "Notifications, 2 unread" })).toBeInTheDocument();
  await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
  FakeEventSource.last!.push("notification", item(4, "Pushed"));
  expect(await screen.findByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
});

test("opening the drawer lists the inbox and clears the count", async () => {
  localStorage.setItem("tw.notify.lastSeenId", "1");
  view();
  await userEvent.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
  expect(await screen.findByText("Item 3")).toBeInTheDocument();
  expect(screen.getByText("Body 2")).toBeInTheDocument();
  expect(localStorage.getItem("tw.notify.lastSeenId")).toBe("3");
});

test("a row opens its link", async () => {
  const { onOpenLink } = view();
  await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  await userEvent.click(await screen.findByText("Item 2"));
  expect(onOpenLink).toHaveBeenCalledWith("/?open=drops&campaign=c2");
});

test("a full page offers the next one", async () => {
  inbox = Array.from({ length: 50 }, (_, i) => item(100 - i));
  view();
  await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Older")).toBeInTheDocument();
  expect(calls).toContain("/api/notify/inbox?before=51");
});

test("an empty inbox says what will appear, and links to the settings", async () => {
  inbox = [];
  const { onOpenSettings } = view();
  await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Notification settings" }));
  expect(onOpenSettings).toHaveBeenCalled();
});
