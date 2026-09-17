import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { CampaignCard, type ResolvedCampaign } from "./CampaignCard.js";
import { renderApp } from "../test-utils.js";

const campaign = (over: Partial<ResolvedCampaign> = {}): ResolvedCampaign => ({
  id: "c1",
  name: "Campaign One",
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1_000,
  endsAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
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
  // The list runs long; every campaign open at once is unreadable. The
  // drops are genuinely unmounted while collapsed (keepMounted={false}),
  // not merely hidden, so a screen reader does not walk a hundred of
  // them -- which is also why the expansion has to be awaited: the
  // content mounts with the enter transition rather than synchronously.
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.queryByTestId("drop-row")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /campaign one/i }));
  await waitFor(() => expect(screen.getByTestId("drop-row")).toBeTruthy());
});

test("says how many drops a campaign has without expanding it", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.getByTestId("campaign-drop-count").textContent).toMatch(/1 drop/i);
});

test("an ended campaign with no progress says ended, not not-started", () => {
  // "NOT STARTED" on a campaign that is over reads as an invitation to
  // start something that cannot be started.
  renderApp(<CampaignCard campaign={campaign({
    status: "untouched", endsAt: Date.now() - 86_400_000,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/ended/i);
});

test("an ended campaign with partial progress also says ended", () => {
  // The progress is frozen and can never be finished, so "in progress"
  // would claim something is happening that is not.
  renderApp(<CampaignCard campaign={campaign({
    status: "partial", endsAt: Date.now() - 86_400_000,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/ended/i);
});

test("an ended campaign that was collected still says collected", () => {
  // A real achievement, and the deadline passing does not undo it.
  renderApp(<CampaignCard campaign={campaign({
    status: "collected", endsAt: Date.now() - 86_400_000,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/collected/i);
});

test("a live campaign keeps its collection state", () => {
  renderApp(<CampaignCard campaign={campaign({
    status: "untouched", endsAt: Date.now() + 86_400_000,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/not started/i);
});

test("a campaign with no end date never reports itself ended", () => {
  // Unknown deadline is not a passed one.
  renderApp(<CampaignCard campaign={campaign({
    status: "untouched", endsAt: null,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/not started/i);
});

test("an ended campaign whose progress is unknown says ended", () => {
  renderApp(<CampaignCard campaign={campaign({
    status: "unknown", endsAt: Date.now() - 86_400_000,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/ended/i);
});

test("shows an inline notice on the row while it is working", () => {
  // On the row, so the feedback cannot be mistaken for another
  // campaign's.
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={() => {}}
                          busy="Finding channels…" />);
  expect(screen.getByTestId("campaign-busy").textContent)
    .toMatch(/finding channels/i);
});

test("no notice when the card is idle", () => {
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={() => {}} />);
  expect(screen.queryByTestId("campaign-busy")).toBeNull();
});

test("the button itself shows it is working", () => {
  // The button is what was clicked; leaving it inert while a notice
  // appears elsewhere reads as the click not registering.
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={() => {}}
                          busy="Finding channels…" />);
  const btn = screen.getByRole("button", { name: /subscribe/i });
  expect(btn.getAttribute("data-loading")).toBe("true");
});

test("a busy card cannot be clicked again", async () => {
  // A second subscribe while the first is in flight would race. Asserted
  // on the effect rather than the attribute: Mantine sets the native
  // `disabled`, not data-disabled.
  const onSubscribe = vi.fn();
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={onSubscribe}
                          busy="Finding channels…" />);
  await userEvent.click(screen.getByRole("button", { name: /subscribe/i }));
  expect(onSubscribe).not.toHaveBeenCalled();
});
