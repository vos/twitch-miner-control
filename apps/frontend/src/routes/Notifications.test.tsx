import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as push from "../lib/push.js";
import { renderLive } from "../test-utils.js";
import { Notifications } from "./Notifications.js";

vi.mock("../lib/push.js", () => ({
  support: vi.fn(() => "ok"),
  enable: vi.fn(),
  disable: vi.fn(async () => {}),
  currentEndpoint: vi.fn(async () => null),
}));

const config = {
  vapidPublicKey: "BKey",
  groups: [{ id: "health", label: "Miner health" }, { id: "streamers", label: "Streamers" }],
  catalogue: [
    { kind: "miner.crashed", group: "health", label: "Miner crashed", description: "d", defaultOn: true },
    { kind: "streamer.online", group: "streamers", label: "Streamer online", description: "d", defaultOn: false },
  ],
};
const prefs = { kinds: {}, streamers: "all", quietHours: null, timeZone: "Europe/Berlin", digestAt: "09:00" };
const dest = (id: string, over: object = {}) => ({
  id, channel: "webpush", label: `Device ${id}`, endpoint: `https://push.example/${id}`,
  prefs, enabled: true, createdTs: 1, lastOkTs: null, lastError: null, lastErrorTs: null, ...over,
});

let calls: Array<{ url: string; init?: RequestInit }>;
let destinations: ReturnType<typeof dest>[];

class FakeEventSource {
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  calls = [];
  destinations = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url === "/api/notify/config") return json(config);
    if (url === "/api/notify/destinations") return json({ destinations });
    if (url === "/api/streamers") {
      return json({ streamers: [{ username: "alpha", displayName: "Alpha" }], lastUpdated: null, stale: true, error: null });
    }
    if (init?.method === "PUT") {
      const id = url.split("/").pop();
      return json({ destination: { ...destinations.find((d) => d.id === id), ...JSON.parse(String(init.body)) } });
    }
    return json({ ok: true });
  }));
  vi.mocked(push.support).mockReturnValue("ok");
  vi.mocked(push.currentEndpoint).mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const view = () => renderLive(<Notifications />);
const sent = (url: string) => {
  const body = calls.find((c) => c.url === url && c.init?.method !== undefined && c.init.method !== "GET")
    ?.init?.body;
  return body === undefined || body === null ? undefined : JSON.parse(String(body));
};

test("without HTTPS the card explains why and offers nothing to press", async () => {
  vi.mocked(push.support).mockReturnValue("insecure");
  view();
  expect(await screen.findByText(/need HTTPS/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /reverse proxy/ }))
    .toHaveAttribute("href", expect.stringContaining("#putting-it-behind-a-reverse-proxy"));
  expect(screen.queryByRole("button", { name: "Turn on notifications" })).toBeNull();
});

test("on an iPhone outside the Home Screen it says how to install", async () => {
  vi.mocked(push.support).mockReturnValue("ios-install");
  view();
  expect(await screen.findByText(/Add to Home Screen/)).toBeInTheDocument();
});

test("turning on registers this browser and shows its events", async () => {
  vi.mocked(push.enable).mockResolvedValue(dest("me") as never);
  view();
  await userEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
  expect(push.enable).toHaveBeenCalledWith("BKey");
  expect(await screen.findByText("Events for this browser")).toBeInTheDocument();
  // Mantine's Switch wraps the label and description in one <label>, so the
  // accessible name is "Miner crashed d" (its description text is "d").
  expect(screen.getByRole("switch", { name: /^Miner crashed\b/ })).toBeChecked();
  expect(screen.getByRole("switch", { name: /^Streamer online\b/ })).not.toBeChecked();
});

test("a refused permission is shown", async () => {
  vi.mocked(push.enable).mockRejectedValue(new Error("Notifications are blocked for this site."));
  view();
  await userEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
  expect(await screen.findByText(/blocked for this site/)).toBeInTheDocument();
});

test("toggling an event saves this browser's preferences", async () => {
  destinations = [dest("me")];
  vi.mocked(push.currentEndpoint).mockResolvedValue("https://push.example/me");
  view();
  await userEvent.click(await screen.findByRole("switch", { name: /^Streamer online\b/ }));
  await waitFor(() => expect(sent("/api/notify/destinations/me")?.prefs.kinds).toEqual({ "streamer.online": true }));
});

test("the streamer filter narrows to chosen streamers", async () => {
  destinations = [dest("me")];
  vi.mocked(push.currentEndpoint).mockResolvedValue("https://push.example/me");
  view();
  await userEvent.click(await screen.findByText("Only these"));
  await waitFor(() => expect(sent("/api/notify/destinations/me")?.prefs.streamers).toEqual([]));
});

test("other devices are listed with their state, and can be removed", async () => {
  destinations = [dest("me"), dest("d2", { lastError: "push service answered 500" })];
  vi.mocked(push.currentEndpoint).mockResolvedValue("https://push.example/me");
  view();
  const row = await screen.findByTestId("destination-d2");
  expect(within(row).getByText("Last delivery failed: push service answered 500")).toBeInTheDocument();
  await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(screen.queryByTestId("destination-d2")).toBeNull());
  expect(calls.some((c) => c.url === "/api/notify/destinations/d2/remove")).toBe(true);
});

test("editing another device's events switches the editor to it", async () => {
  destinations = [dest("me"), dest("d2")];
  vi.mocked(push.currentEndpoint).mockResolvedValue("https://push.example/me");
  view();
  await userEvent.click(within(await screen.findByTestId("destination-d2")).getByRole("button", { name: "Edit events" }));
  expect(await screen.findByText("Events for Device d2")).toBeInTheDocument();
});
