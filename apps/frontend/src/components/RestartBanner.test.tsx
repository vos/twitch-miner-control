import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RestartBanner } from "./RestartBanner.js";
import { renderApp } from "../test-utils.js";

const pending = (over: object = {}) => ({
  pending: true, dueAt: Date.now() + 60_000,
  reason: "drop subscriptions resolved new channels", ...over,
});

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

test("renders nothing when no restart is pending", () => {
  // Queried by testid rather than container.firstChild: renderApp wraps
  // in MantineProvider, so the container is never empty.
  renderApp(
    <RestartBanner state={{ pending: false, dueAt: null, reason: null }}
                   onCancel={() => {}} onNow={() => {}} />,
  );
  expect(screen.queryByTestId("restart-banner")).toBeNull();
});

test("shows both actions while pending", () => {
  renderApp(<RestartBanner state={pending()} onCancel={() => {}} onNow={() => {}} />);
  expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /restart now/i })).toBeTruthy();
});

test("says why the miner wants to restart", () => {
  // Without the reason it is an unexplained interruption.
  renderApp(<RestartBanner state={pending()} onCancel={() => {}} onNow={() => {}} />);
  expect(screen.getByTestId("restart-reason").textContent)
    .toMatch(/resolved new channels/i);
});

test("counts down the remaining seconds", () => {
  renderApp(<RestartBanner state={pending({ dueAt: Date.now() + 42_000 })}
                           onCancel={() => {}} onNow={() => {}} />);
  expect(screen.getByTestId("restart-countdown").textContent).toMatch(/42\s*s/);
});

test("a countdown already past reads as restarting, not as negative", () => {
  renderApp(<RestartBanner state={pending({ dueAt: Date.now() - 5_000 })}
                           onCancel={() => {}} onNow={() => {}} />);
  const text = screen.getByTestId("restart-countdown").textContent ?? "";
  expect(text).not.toMatch(/-/);
});

test("a pending restart with no deadline still renders", () => {
  renderApp(<RestartBanner state={pending({ dueAt: null })}
                           onCancel={() => {}} onNow={() => {}} />);
  expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
});

test("cancel and restart-now call through", async () => {
  const onCancel = vi.fn();
  const onNow = vi.fn();
  renderApp(<RestartBanner state={pending()} onCancel={onCancel} onNow={onNow} />);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(screen.getByRole("button", { name: /cancel/i }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: /restart now/i }));
  expect(onNow).toHaveBeenCalledTimes(1);
});
