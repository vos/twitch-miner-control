import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Settings } from "./Settings.js";
import { renderApp, restoreRects, stubRowRects } from "../test-utils.js";

const config = {
  version: 1, username: "alex", followers: false, followersOrder: "ASC",
  defaults: {}, miner: {}, streamers: [],
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
afterEach(() => { vi.unstubAllGlobals(); restoreRects(); });

const view = () => renderApp(<Settings />);

/** The body of the PUT the Apply button sent, parsed. */
const sentConfig = () => {
  const put = calls.find((c) => c.url === "/api/config" && c.init?.method === "PUT");
  return JSON.parse(String(put?.init?.body));
};

/**
 * Drives one pointer drag from `handle` by `dy` pixels.
 *
 * Mirrors the helper in Streamers.test.tsx: dnd-kit's PointerSensor only
 * begins a drag once the pointer has travelled past its activation
 * distance, so the move is sent in two steps.
 */
async function dragBy(handle: HTMLElement, dy: number) {
  const user = userEvent.setup();
  await user.pointer([
    { keys: "[MouseLeft>]", target: handle, coords: { x: 10, y: 10 } },
    { target: handle, coords: { x: 10, y: 10 + Math.sign(dy) * 20 } },
    { target: handle, coords: { x: 10, y: 10 + dy } },
    { keys: "[/MouseLeft]", target: handle, coords: { x: 10, y: 10 + dy } },
  ]);
}

/** Adds priorities by clicking their add-buttons, in the order given. */
async function addPriorities(...labels: string[]) {
  for (const label of labels) {
    await userEvent.click(screen.getByRole("button", { name: label }));
  }
}

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

test("edits a global default and stages it", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByRole("switch", { name: "Community goals" }));
  // findByRole, not getByRole: PendingBar is absent from the DOM until a
  // change is staged and then slides in over 180ms, so a synchronous query
  // races the transition.
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));
  await waitFor(() => {
    const put = calls.find((c) => c.url === "/api/config" && c.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body)).defaults.communityGoals).toBe(true);
  });
});

test("global defaults have no inherit control -- they are the defaults", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  expect(screen.queryByRole("switch", { name: /^Override/ })).not.toBeInTheDocument();
});

test("stages the miner-wide priority order", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await addPriorities("Watch streaks");
  // findByRole, not getByRole: PendingBar is absent from the DOM until a
  // change is staged and then slides in over 180ms, so a synchronous query
  // races the transition.
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));
  await waitFor(() => {
    expect(sentConfig().miner.priority).toEqual(["STREAK"]);
  });
});

/**
 * `priority` is an ordered list -- the miner consults the rules from first
 * to last -- so these assert on sequence with toEqual. The control this
 * replaced was a checkbox group, which emitted its value in the DOM order
 * of the checkboxes rather than the order the user chose: every assertion
 * below fails against it, while the old `toContain("STREAK")` passed.
 */
test("sends the priorities in the order they were added, not a fixed order", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);

  // "List order" sits *after* "Drops" in the offered list, so a control
  // keyed on display order could not produce this sequence.
  await addPriorities("List order", "Drops");
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));

  await waitFor(() => {
    expect(sentConfig().miner.priority).toEqual(["ORDER", "DROPS"]);
  });
});

test("dragging a priority down reorders what is sent", async () => {
  stubRowRects("priority-row");
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await addPriorities("Watch streaks", "Drops", "List order");

  // Drag the first rule (Watch streaks) down one row, past Drops' midpoint.
  await dragBy(screen.getAllByRole("button", { name: /^Reorder/ })[0], 60);

  const rows = screen.getAllByTestId("priority-row");
  expect(rows[0].textContent).toContain("Drops");
  expect(rows[1].textContent).toContain("Watch streaks");

  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));
  await waitFor(() => {
    expect(sentConfig().miner.priority).toEqual(["DROPS", "STREAK", "ORDER"]);
  });
});

test("the priority order is reachable from the keyboard alone", async () => {
  stubRowRects("priority-row");
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await addPriorities("Watch streaks", "Drops");

  // Space lifts, arrow moves, space drops -- the only reorder path for a
  // keyboard user, since the grip is the sole handle.
  screen.getAllByRole("button", { name: /^Reorder/ })[0].focus();
  await userEvent.keyboard("{ }");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{ }");

  const rows = screen.getAllByTestId("priority-row");
  expect(rows[0].textContent).toContain("Drops");
  expect(rows[1].textContent).toContain("Watch streaks");
});

test("removing a priority drops it from the list", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await addPriorities("Watch streaks", "Drops");

  await userEvent.click(screen.getByRole("button", { name: "Remove Watch streaks" }));
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));

  await waitFor(() => {
    expect(sentConfig().miner.priority).toEqual(["DROPS"]);
  });
});

test("an empty selection sends no priority key at all", async () => {
  // Upstream distinguishes "no priority given" (use the built-in order)
  // from an empty list, so the key has to be absent rather than [].
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  expect(screen.getByTestId("priority-empty")).toBeInTheDocument();

  // Add then remove, to leave a staged change with an empty selection.
  await addPriorities("Watch streaks");
  await userEvent.click(screen.getByRole("button", { name: "Remove Watch streaks" }));
  await userEvent.click(screen.getByLabelText(/mine my followed channels/i));
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));

  await waitFor(() => {
    expect(sentConfig().miner).not.toHaveProperty("priority");
  });
});

// --- upstream defaults are visible without touching anything ---

test("spells out the built-in priority order when nothing is selected", async () => {
  // With no priority set the miner uses watch_session, watch_streak,
  // weekly_rewards, drops, order (TwitchChannelPointsMiner.py). Naming the
  // order but not its contents left the user guessing or reading source.
  view();
  await screen.findByLabelText(/mine my followed channels/i);

  const empty = screen.getByTestId("priority-empty");
  expect(empty).toHaveTextContent("Watch session");
  expect(empty).toHaveTextContent("Watch streaks");
  expect(empty).toHaveTextContent("Weekly rewards");
  expect(empty).toHaveTextContent("Drops");
  expect(empty).toHaveTextContent("List order");
  // Not part of the built-in order -- offering them here would misreport it.
  expect(empty).not.toHaveTextContent("Subscribed");
  expect(empty).not.toHaveTextContent("Fewest points first");
});

test("the built-in priority order is listed in upstream's own order", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);

  const text = screen.getByTestId("priority-empty").textContent ?? "";
  const positions = ["Watch session", "Watch streaks", "Weekly rewards", "Drops", "List order"]
    .map((label) => text.indexOf(label));
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(positions.every((p) => p >= 0)).toBe(true);
});

test("the built-in order disappears once a rule is chosen", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await addPriorities("Drops");
  // It described what the miner would do *instead* of the selection, so
  // leaving it on screen beside a real order would contradict it.
  expect(screen.queryByTestId("priority-empty")).not.toBeInTheDocument();
});

test("shows the built-in retry and weekly defaults before anything is customised", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);

  // AttemptStrategy defaults: 3 attempts, 1 second apart.
  expect(screen.getByTestId("gql-default")).toHaveTextContent("attempts 3");
  expect(screen.getByTestId("gql-default")).toHaveTextContent("retry delay 1");

  // BasicConfiguration defaults -- 3 concurrent, not example.py's 2.
  const weekly = screen.getByTestId("weekly-default");
  expect(weekly).toHaveTextContent("concurrent channels 3");
  expect(weekly).toHaveTextContent("clip watch seconds 30");
  expect(weekly).toHaveTextContent("vod watch seconds 480");
  expect(weekly).toHaveTextContent("cooldown seconds 3600");
});

test("the default summaries give way to the inputs once customised", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);

  await userEvent.click(screen.getByLabelText(/customise retries/i));
  expect(screen.queryByTestId("gql-default")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("radio", { name: "Customise" }));
  expect(screen.queryByTestId("weekly-default")).not.toBeInTheDocument();
});

test("disabling weekly rewards hides the built-in summary too", async () => {
  // Disabled means no progression at all, so describing the built-in
  // configuration there would say the opposite of what happens.
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByRole("radio", { name: "Disabled" }));
  expect(screen.queryByTestId("weekly-default")).not.toBeInTheDocument();
});

// --- miner-wide GQL retry options ---

test("retries are off until customised, and enabling seeds both upstream defaults", async () => {
  // The schema requires both fields once `gql` is present, so enabling has
  // to write a complete object or the PUT would be rejected.
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  expect(screen.queryByLabelText("Attempts")).not.toBeInTheDocument();

  await userEvent.click(screen.getByLabelText(/customise retries/i));
  expect(screen.getByLabelText("Attempts")).toHaveValue("3");
  expect(screen.getByLabelText("Retry delay")).toHaveValue("1");

  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));
  await waitFor(() => {
    expect(sentConfig().miner.gql).toEqual({ attempts: 3, attemptIntervalSeconds: 1 });
  });
});

test("editing a retry field sends the edited value", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByLabelText(/customise retries/i));

  const attempts = screen.getByLabelText("Attempts");
  await userEvent.clear(attempts);
  await userEvent.type(attempts, "5");
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));

  await waitFor(() => {
    expect(sentConfig().miner.gql.attempts).toBe(5);
  });
});

test("turning retries back off removes the key entirely", async () => {
  // Absent means "use upstream's own AttemptStrategy", which is not the
  // same as an object full of zeros.
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByLabelText(/customise retries/i));
  await userEvent.click(screen.getByLabelText(/customise retries/i));

  await userEvent.click(screen.getByLabelText(/mine my followed channels/i));
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));
  await waitFor(() => {
    expect(sentConfig().miner).not.toHaveProperty("gql");
  });
});

// --- miner-wide weekly rewards options ---

test("weekly rewards starts on the built-in configuration", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  expect(screen.getByRole("radio", { name: "Built-in" })).toBeChecked();
  // No number fields until it is actually being customised.
  expect(screen.queryByLabelText("Concurrent channels")).not.toBeInTheDocument();
});

test("disabling weekly rewards sends false, not an empty object", async () => {
  // Upstream reads `false` as "do not progress weekly rewards at all";
  // an absent key or {} would instead run the built-in progression.
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByRole("radio", { name: "Disabled" }));
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));

  await waitFor(() => {
    expect(sentConfig().miner.weeklyRewards).toBe(false);
  });
});

test("customising weekly rewards sends only the fields that were set", async () => {
  // Each field is individually optional: an untouched field must stay
  // absent so upstream fills in its own default rather than a zero.
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByRole("radio", { name: "Customise" }));

  const concurrent = screen.getByLabelText("Concurrent channels");
  await userEvent.clear(concurrent);
  await userEvent.type(concurrent, "10");
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));

  await waitFor(() => {
    expect(sentConfig().miner.weeklyRewards).toEqual({ maxConcurrent: 10 });
  });
});

test("the weekly number fields show upstream's defaults as placeholders", async () => {
  // The dataclass defaults, not example.py's -- upstream's own guide
  // documents max_concurrent as 2 where BasicConfiguration says 3.
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByRole("radio", { name: "Customise" }));

  expect(screen.getByLabelText("Concurrent channels")).toHaveAttribute("placeholder", "3");
  expect(screen.getByLabelText("Cooldown seconds")).toHaveAttribute("placeholder", "3600");
});

test("clearing every weekly field falls back to the built-in configuration", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByRole("radio", { name: "Customise" }));

  const concurrent = screen.getByLabelText("Concurrent channels");
  await userEvent.clear(concurrent);
  await userEvent.type(concurrent, "4");
  await userEvent.clear(concurrent);

  // Back to an empty object rather than {maxConcurrent: 0}: clearing an
  // input drops the key instead of writing a zero.
  await userEvent.click(screen.getByLabelText(/mine my followed channels/i));
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));
  await waitFor(() => {
    expect(sentConfig().miner.weeklyRewards).toEqual({});
  });
});

test("switching weekly rewards back to built-in removes the key", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByRole("radio", { name: "Disabled" }));
  await userEvent.click(screen.getByRole("radio", { name: "Built-in" }));

  await userEvent.click(screen.getByLabelText(/mine my followed channels/i));
  await userEvent.click(await screen.findByRole("button", { name: /apply/i }));
  await waitFor(() => {
    expect(sentConfig().miner).not.toHaveProperty("weeklyRewards");
  });
});

test("a selected priority is no longer offered as an add-button", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  expect(screen.getByRole("button", { name: "Watch streaks" })).toBeInTheDocument();

  await addPriorities("Watch streaks");

  // It moved into the ordered list, so only the row and its remove button
  // remain -- no add-button that would duplicate it.
  expect(screen.queryByRole("button", { name: "Watch streaks" })).not.toBeInTheDocument();
  expect(screen.getAllByTestId("priority-row")).toHaveLength(1);
});
