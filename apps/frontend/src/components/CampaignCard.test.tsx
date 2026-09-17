import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { CampaignCard, type ResolvedCampaign } from "./CampaignCard.js";
import { renderApp } from "../test-utils.js";

const campaign = (over: Partial<ResolvedCampaign> = {}): ResolvedCampaign => ({
  id: "c1",
  name: "Campaign One",
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1_000,
  endsAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
  allowChannelIds: [],
  status: "untouched",
  drops: [
    { id: "d1", name: "Crate", benefits: ["Crate"],
      requiredMinutes: 60, minutes: 0, status: "not-started" },
  ],
  ...over,
});

test("shows the campaign name and its game", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.getByText("Campaign One")).toBeTruthy();
  expect(screen.getByText("A Game")).toBeTruthy();
});

test("a campaign with no game reported omits it rather than guessing", () => {
  renderApp(<CampaignCard campaign={campaign({ game: null })} />);
  expect(screen.queryByTestId("campaign-game")).toBeNull();
});

test("reports how long the campaign has left", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.getByTestId("campaign-ends").textContent).toMatch(/ends in/i);
});

test("a campaign already over says so rather than counting backwards", () => {
  renderApp(
    <CampaignCard campaign={campaign({ endsAt: Date.now() - 60_000 })} />,
  );
  expect(screen.getByTestId("campaign-ends").textContent).toMatch(/ended/i);
});

test("a campaign with no end date reported shows no deadline", () => {
  renderApp(<CampaignCard campaign={campaign({ endsAt: null })} />);
  expect(screen.queryByTestId("campaign-ends")).toBeNull();
});

test("shows the collection verdict", () => {
  renderApp(<CampaignCard campaign={campaign({ status: "collected" })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/collected/i);
});

test("an unknown verdict is not rendered as untouched", () => {
  // Reporting "untouched" when we could not read the inventory would be
  // a confident claim about progress we do not have.
  renderApp(<CampaignCard campaign={campaign({ status: "unknown" })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/unknown/i);
});

test("drops are hidden until the card is expanded", async () => {
  // The list runs long; every campaign open at once is unreadable.
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.queryByTestId("drop-row")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /crate|drop|expand/i }));
  expect(screen.getByTestId("drop-row")).toBeTruthy();
});

test("says how many drops a campaign has without expanding it", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.getByTestId("campaign-drop-count").textContent).toMatch(/1 drop/i);
});
