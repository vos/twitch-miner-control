import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { FollowGamesDialog } from "./FollowGamesDialog.js";

const game = (id: string, name: string) => ({ id, name, slug: name.toLowerCase(), boxArtUrl: null });
const elden = game("512953", "ELDEN RING");
const rust = game("263490", "Rust");

let searches: string[];
/** Answers /api/games/search from `answer(q)`; a thrown answer is a 502. */
function stubSearch(answer: (q: string) => Promise<unknown> | unknown) {
  searches = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const q = new URL(url, "http://x").searchParams.get("q") ?? "";
    searches.push(q);
    try {
      const games = await answer(q);
      return { ok: true, status: 200, json: async () => ({ games }) };
    } catch {
      return { ok: false, status: 502, json: async () => ({ error: "Twitch search is unavailable" }) };
    }
  }));
}
afterEach(() => { vi.unstubAllGlobals(); });

const open = (over: object = {}) => {
  const onConfirm = vi.fn(async () => {});
  const onClose = vi.fn();
  renderApp(<FollowGamesDialog opened onClose={onClose} followed={[]} campaigns={[]}
    onConfirm={onConfirm} {...over} />);
  return { onConfirm, onClose };
};
const box = () => screen.getByRole("textbox", { name: /search twitch games/i });

test("asks for two characters before searching", async () => {
  stubSearch(() => []);
  open();
  await userEvent.type(box(), "e");
  expect(screen.getByText("Type a game name or Twitch ID")).toBeTruthy();
  await new Promise((r) => setTimeout(r, 350));
  expect(searches).toEqual([]);
});

test("typing quickly sends one search for the final text", async () => {
  stubSearch(() => [elden]);
  open();
  await userEvent.type(box(), "elden");
  await screen.findByText("ELDEN RING");
  expect(searches).toEqual(["elden"]);
});

test("no matches and a failed search read differently", async () => {
  stubSearch((q) => { if (q === "zzz") return []; throw new Error("down"); });
  open();
  await userEvent.type(box(), "zzz");
  expect(await screen.findByText("No matching games")).toBeTruthy();
  await userEvent.clear(box());
  await userEvent.type(box(), "boom");
  expect(await screen.findByText(/Twitch search is unavailable/)).toBeTruthy();
});

test("an older search answering late does not replace a newer one", async () => {
  let releaseOld!: () => void;
  stubSearch((q) => q === "ru"
    ? new Promise((r) => { releaseOld = () => r([game("1", "Rusty Lake")]); })
    : [rust]);
  open();
  await userEvent.type(box(), "ru");
  await waitFor(() => expect(searches).toEqual(["ru"]));
  await userEvent.type(box(), "st");
  await screen.findByText("Rust");
  releaseOld();
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText("Rusty Lake")).toBeNull();
});

test("picks survive a second search and are confirmed together", async () => {
  stubSearch((q) => (q.startsWith("eld") ? [elden] : [rust]));
  const { onConfirm, onClose } = open();
  await userEvent.type(box(), "elden");
  await userEvent.click(await screen.findByRole("checkbox", { name: "Follow ELDEN RING" }));
  await userEvent.clear(box());
  await userEvent.type(box(), "rust");
  await userEvent.click(await screen.findByRole("checkbox", { name: "Follow Rust" }));
  expect(within(screen.getByTestId("follow-picked")).getByText("ELDEN RING")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Follow 2 games" }));
  expect(onConfirm).toHaveBeenCalledWith([elden, rust]);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test("a game already followed is shown ticked and cannot be picked again", async () => {
  stubSearch(() => [elden]);
  open({ followed: [{ ...elden, poolSize: 3, skipped: [] }] });
  await userEvent.type(box(), "elden");
  const tick = await screen.findByRole("checkbox", { name: "Follow ELDEN RING" });
  expect(tick).toBeChecked();
  expect(tick).toBeDisabled();
  expect(screen.getByText("Following")).toBeTruthy();
});

test("a failed follow keeps the dialog open with the reason", async () => {
  stubSearch(() => [elden]);
  const { onClose } = open({
    onConfirm: vi.fn(async () => { throw new Error("Twitch could not be reached"); }),
  });
  await userEvent.type(box(), "elden");
  await userEvent.click(await screen.findByRole("checkbox", { name: "Follow ELDEN RING" }));
  await userEvent.click(screen.getByRole("button", { name: "Follow 1 game" }));
  expect(await screen.findByText(/Twitch could not be reached/)).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});
