import { MantineProvider } from "@mantine/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { DropBadge } from "./DropBadge.js";

const drop = {
  name: "Charm", minutes: 20, required: 60, claimable: false, benefits: [], endsAt: null,
};

function renderBadge(over: object) {
  render(<MantineProvider><DropBadge drop={{ ...drop, ...over }} /></MantineProvider>);
}

test("a drop earned on an unlinked account does not promise a claim", () => {
  renderBadge({ minutes: 60, claimable: true, linked: false });
  expect(screen.getByTestId("drop")).toHaveTextContent("link to claim");
});

test("a drop earned on a linked account is ready", () => {
  renderBadge({ minutes: 60, claimable: true, linked: true });
  expect(screen.getByTestId("drop")).toHaveTextContent("drop ready");
});

test("the detail says why an unlinked drop will not be claimed, and where to link", async () => {
  renderBadge({ linked: false, linkUrl: "https://example.com/link" });
  await userEvent.click(screen.getByTestId("drop"));
  const note = await screen.findByTestId("drop-unlinked");
  expect(note).toHaveTextContent("linked");
  expect(within(note).getByRole("link", { hidden: true }))
    .toHaveAttribute("href", "https://example.com/link");
});

test("an unlinked drop with no link address still explains itself", async () => {
  renderBadge({ linked: false, linkUrl: null });
  await userEvent.click(screen.getByTestId("drop"));
  const note = await screen.findByTestId("drop-unlinked");
  expect(within(note).queryByRole("link", { hidden: true })).toBeNull();
});

test("a finished unlinked drop does not read as ready in the detail", async () => {
  renderBadge({ minutes: 60, claimable: true, linked: false });
  await userEvent.click(screen.getByTestId("drop"));
  expect(await screen.findByTestId("drop-remaining")).toHaveTextContent("needs a linked account");
});

test("a linked drop shows no such note", async () => {
  renderBadge({ linked: true });
  await userEvent.click(screen.getByTestId("drop"));
  await screen.findByTestId("drop-remaining");
  expect(screen.queryByTestId("drop-unlinked")).toBeNull();
});
