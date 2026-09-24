import { expect, test, vi } from "vitest";
import type { DaySummary } from "../../insights/recap.js";
import { defaultPrefs } from "../prefs.js";
import type { Destination } from "../store.js";
import { DigestScheduler, digestNotification } from "./digest.js";

const summary = (over: Partial<DaySummary> = {}): DaySummary => ({
  day: "2026-09-23", earned: 12_400, minedMs: 6.5 * 3_600_000, dropsClaimed: 2,
  top: { login: "alpha", displayName: "Alpha", earned: 4_100 }, hasData: true, ...over,
});

const dest = (over: Partial<Destination> = {}): Destination => ({
  id: "d1", channel: "webpush", label: "Phone", endpoint: "e", subscription: null,
  prefs: { ...defaultPrefs("Europe/Berlin"), kinds: { "digest.daily": true } },
  enabled: true, createdTs: 1, lastOkTs: null, lastError: null, lastErrorTs: null, ...over,
});

function harness(destinations: Destination[], day = summary()) {
  let now = 0;
  const seen = new Set<string>();
  const sendTo = vi.fn(async () => ({ ok: true as const }));
  const summaryFn = vi.fn(() => day);
  const scheduler = new DigestScheduler({
    notifier: { sendTo, markSeen: (k: string) => (seen.has(k) ? false : (seen.add(k), true)) },
    store: { list: () => destinations },
    summary: summaryFn,
    now: () => now,
  });
  return { scheduler, sendTo, summaryFn, at: (ms: number) => { now = ms; } };
}

test("the digest goes out once a local day, at or after its time", () => {
  const h = harness([dest()]);
  h.at(Date.UTC(2026, 8, 24, 6, 59)); // 08:59 in Berlin
  h.scheduler.tick();
  expect(h.sendTo).not.toHaveBeenCalled();
  h.at(Date.UTC(2026, 8, 24, 7, 0)); // 09:00
  h.scheduler.tick();
  h.at(Date.UTC(2026, 8, 24, 7, 1));
  h.scheduler.tick();
  expect(h.sendTo).toHaveBeenCalledTimes(1);
  expect(h.summaryFn).toHaveBeenCalledWith("2026-09-23");
  h.at(Date.UTC(2026, 8, 25, 7, 0));
  h.scheduler.tick();
  expect(h.sendTo).toHaveBeenCalledTimes(2);
});

test("off, paused or empty means nothing is sent", () => {
  const off = harness([dest({ prefs: defaultPrefs("Europe/Berlin") })]);
  const paused = harness([dest({ enabled: false })]);
  const empty = harness([dest()], summary({ hasData: false }));
  for (const h of [off, paused, empty]) {
    h.at(Date.UTC(2026, 8, 24, 8));
    h.scheduler.tick();
    expect(h.sendTo).not.toHaveBeenCalled();
  }
});

test("the digest reads as one line of figures", () => {
  expect(digestNotification(summary())).toEqual({
    kind: "digest.daily", title: "Yesterday's mining",
    body: "+12.4K points · 2 drops claimed · 6.5 h mined · Top: Alpha +4.1K",
    link: "/?open=insights",
  });
  expect(digestNotification(summary({ dropsClaimed: 0, top: null })).body)
    .toBe("+12.4K points · 6.5 h mined");
});
