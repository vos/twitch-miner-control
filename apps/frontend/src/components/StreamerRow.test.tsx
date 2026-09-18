import { screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { expect, test } from "vitest";
import { StreamerRow } from "./StreamerRow.js";
import { renderApp } from "../test-utils.js";

const LONG = "averyverylongstreamernamethatwillnotfit";

function row(username = LONG, watching = true) {
  return renderApp(
    <DndContext>
      <SortableContext items={[username]}>
        <StreamerRow
          username={username}
          enabled
          index={0}
          watching={watching}
          status={{
            avatarUrl: null, isOnline: true,
            liveSince: Date.now() - 3600_000, lastLive: null, watching,
          }}
          onToggle={() => {}}
          onRemove={() => {}}
          onOpenSettings={() => {}}
        />
      </SortableContext>
    </DndContext>,
  );
}

/**
 * jsdom reports every box as 0x0, so these assert the structure the
 * layout depends on rather than the pixels it produces -- the widths
 * themselves are covered by the browser checks in the PR.
 *
 * The bug being pinned: the row used to be two nowrap flex groups, and
 * the identity group's content width won, pushing the switch, settings
 * and remove controls off the card. At 320px they were unreachable.
 */
test("the controls are not inside the block that truncates", () => {
  row();
  // If a control is ever nested back into the identity block it inherits
  // that block's shrinking and can be pushed out of the card again.
  const identity = screen.getByRole("link", { name: LONG }).parentElement!;
  for (const name of [`Enable ${LONG}`, `Settings for ${LONG}`, `Remove ${LONG}`]) {
    expect(identity).not.toContainElement(screen.getByLabelText(name));
  }
});

test("every control is rendered however long the name is", () => {
  row();
  expect(screen.getByLabelText(`Enable ${LONG}`)).toBeInTheDocument();
  expect(screen.getByLabelText(`Settings for ${LONG}`)).toBeInTheDocument();
  expect(screen.getByLabelText(`Remove ${LONG}`)).toBeInTheDocument();
  expect(screen.getByLabelText(`Reorder ${LONG}`)).toBeInTheDocument();
});

test("the truncated name keeps the full one reachable", () => {
  row();
  // The name is the element that loses width, so the whole of it has to
  // survive somewhere a user can still get at.
  const link = screen.getByRole("link", { name: LONG });
  expect(link).toHaveAttribute("title", LONG);
  expect(link).toHaveAttribute("href", `https://twitch.tv/${LONG}`);
});

test("the live duration is separable from the state word", () => {
  row();
  // The row hides the duration on a narrow container to keep the channel
  // name readable, which needs it in an element of its own -- a bare text
  // node beside "LIVE" could not be targeted. jsdom applies no container
  // queries, so this pins the hook rather than the hiding.
  const pill = screen.getByTestId("live-pill");
  expect(pill).toHaveTextContent(/^LIVE \d/);
  expect(screen.getByTestId("live-span")).toBeInTheDocument();
});

test("a channel that is not being watched renders no tag", () => {
  row(LONG, false);
  expect(screen.queryByTestId("watching-tag")).not.toBeInTheDocument();
});

/**
 * A subscription-owned row. The engine rewrites these on every pass, so
 * the screen's job is to say where the channel came from and to keep the
 * user from staging an edit that the next pass would silently undo.
 */
function ownedRow(ownedByLabel: string | null = "Rust Twitch Drops") {
  return renderApp(
    <DndContext>
      <SortableContext items={["alpha"]}>
        <StreamerRow
          username="alpha"
          enabled
          index={0}
          watching={false}
          ownedByLabel={ownedByLabel}
          status={null}
          onToggle={() => {}}
          onRemove={() => {}}
          onOpenSettings={() => {}}
        />
      </SortableContext>
    </DndContext>,
  );
}

test("names the campaign that a subscription-owned channel came from", () => {
  ownedRow();
  expect(screen.getByTestId("owned-tag")).toHaveTextContent("Rust Twitch Drops");
});

test("an owned row offers no reorder, settings or remove control", () => {
  ownedRow();
  // Each of these stages an edit the engine's next pass would overwrite,
  // so offering them at all would be a lie about what the screen does.
  expect(screen.queryByLabelText("Reorder alpha")).toBeNull();
  expect(screen.queryByLabelText("Settings for alpha")).toBeNull();
  expect(screen.queryByLabelText("Remove alpha")).toBeNull();
});

test("an owned row can still be disabled by hand", () => {
  // The one edit that survives: `enabled` is the user's say over whether
  // the miner watches a channel, and reconcile preserves it across passes
  // rather than resetting it.
  ownedRow();
  expect(screen.getByLabelText("Enable alpha")).toBeInTheDocument();
});

test("a hand-added row keeps every control and shows no campaign tag", () => {
  ownedRow(null);
  expect(screen.queryByTestId("owned-tag")).toBeNull();
  expect(screen.getByLabelText("Reorder alpha")).toBeInTheDocument();
  expect(screen.getByLabelText("Remove alpha")).toBeInTheDocument();
});
