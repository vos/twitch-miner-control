import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { FollowedGamesCard } from "./FollowedGamesCard.js";

const elden = { id: "512953", name: "ELDEN RING", slug: "elden-ring", boxArtUrl: null, poolSize: 3, skipped: [] };
const running = {
  id: "c1", name: "Nightreign", startsAt: 1, endsAt: Date.now() + 86_400_000,
  game: { id: "512953", slug: "elden-ring", displayName: "ELDEN RING" },
  drops: [], status: "untouched",
} as never;

const props = (over: object = {}) => ({
  games: [elden], campaigns: [running], skipped: [], busy: false, notice: null,
  onAdd: vi.fn(), onRemove: vi.fn(), onPoolSize: vi.fn(), ...over,
});

test("with nothing followed it explains what following does", () => {
  renderApp(<FollowedGamesCard {...props({ games: [] })} />);
  expect(screen.getByText(/subscribe to its drop campaigns automatically/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /follow games/i })).toBeTruthy();
});

test("a followed game shows its running campaigns and links to Twitch", () => {
  renderApp(<FollowedGamesCard {...props()} />);
  const row = screen.getByTestId("followed-game");
  expect(row.textContent).toMatch(/1 campaign running/);
  expect(within(row).getByRole("link", { name: /ELDEN RING/ }).getAttribute("href"))
    .toBe("https://twitch.tv/directory/category/elden-ring");
});

test("a game with nothing running says so", () => {
  renderApp(<FollowedGamesCard {...props({ campaigns: [] })} />);
  expect(screen.getByTestId("followed-game").textContent).toMatch(/No campaigns right now/);
});

test("remove and pool size report the game", async () => {
  const p = props();
  renderApp(<FollowedGamesCard {...p} />);
  await userEvent.click(screen.getByRole("button", { name: /unfollow ELDEN RING/i }));
  expect(p.onRemove).toHaveBeenCalledWith("512953");
  const input = screen.getByLabelText("Channels for ELDEN RING");
  await userEvent.clear(input);
  await userEvent.type(input, "5{Enter}");
  expect(p.onPoolSize).toHaveBeenCalledWith("512953", 5);
});

test("the notice shows what the last follow did", () => {
  renderApp(<FollowedGamesCard {...props({ notice: "Following Rust · 1 campaign subscribed" })} />);
  expect(screen.getByTestId("follow-notice").textContent).toBe("Following Rust · 1 campaign subscribed");
});

test("followed games are listed by name, whatever order they were followed in", () => {
  const game = (id: string, name: string) => ({ ...elden, id, name, slug: "" });
  renderApp(<FollowedGamesCard {...props({
    games: [game("1", "World of Tanks"), game("2", "apex Legends"), game("3", "ELDEN RING")],
  })} />);
  const names = screen.getAllByText(/^(apex Legends|ELDEN RING|World of Tanks)$/)
    .map((el) => el.textContent);
  expect(names).toEqual(["apex Legends", "ELDEN RING", "World of Tanks"]);
});
