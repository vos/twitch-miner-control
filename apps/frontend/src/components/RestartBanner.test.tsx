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

test("floats above the page rather than scrolling away with it", () => {
  // The Drops list runs to seventy campaigns, so a banner in the normal
  // flow is off-screen for exactly the interaction that triggers it.
  renderApp(<RestartBanner state={pending()} onCancel={() => {}} onNow={() => {}} />);
  // Affix positions via a class and emits --affix-* custom properties,
  // so the inline style carries the offset rather than `position`.
  const affix = screen.getByTestId("restart-banner")
    .closest("[style*='--affix-bottom']");
  expect(affix).not.toBeNull();
});

test("is only as wide as its content, and clears the sidebar", () => {
  // Spanning the window drew the banner underneath the sidebar at narrow
  // widths, and stretched a two-line message across 900px for no reason.
  renderApp(<RestartBanner state={pending()} onCancel={() => {}} onNow={() => {}} />);
  const banner = screen.getByTestId("restart-banner");
  const style = banner.getAttribute("style") ?? "";
  // Anchored: `max-width: 100%` is fine and contains the same substring.
  expect(style).not.toMatch(/(^|;)\s*width: 100%/);
  const affix = banner.closest("[style*='--affix-bottom']") as HTMLElement;
  // Offset by the sidebar rather than pinned to the window edge. Set as
  // a plain `left` rather than through Affix's position prop, so it can
  // reference Mantine's navbar-offset variable and follow the sidebar
  // collapsing.
  expect(affix.getAttribute("style"))
    .toMatch(/left: var\(--app-shell-navbar-offset/);
});

test("stays quiet while the restart is comfortably away", () => {
  renderApp(<RestartBanner state={pending({ dueAt: Date.now() + 45_000 })}
                           onCancel={() => {}} onNow={() => {}} />);
  expect(screen.getByTestId("restart-banner").getAttribute("data-urgent"))
    .toBe("false");
});

test("gets louder in the last ten seconds", () => {
  // Sixty seconds out this is a quiet notice; ten seconds out it is
  // about to interrupt whatever the user is doing, and someone who
  // missed it the first time needs a second chance to catch it.
  renderApp(<RestartBanner state={pending({ dueAt: Date.now() + 9_000 })}
                           onCancel={() => {}} onNow={() => {}} />);
  expect(screen.getByTestId("restart-banner").getAttribute("data-urgent"))
    .toBe("true");
});

test("ten seconds exactly is already urgent", () => {
  renderApp(<RestartBanner state={pending({ dueAt: Date.now() + 10_000 })}
                           onCancel={() => {}} onNow={() => {}} />);
  expect(screen.getByTestId("restart-banner").getAttribute("data-urgent"))
    .toBe("true");
});

test("a restart with no deadline is never urgent", () => {
  // Nothing to count down to, so nothing to escalate about.
  renderApp(<RestartBanner state={pending({ dueAt: null })}
                           onCancel={() => {}} onNow={() => {}} />);
  expect(screen.getByTestId("restart-banner").getAttribute("data-urgent"))
    .toBe("false");
});

test("the countdown becomes urgent as the clock runs down", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    renderApp(<RestartBanner state={pending({ dueAt: Date.now() + 12_000 })}
                             onCancel={() => {}} onNow={() => {}} />);
    const banner = screen.getByTestId("restart-banner");
    expect(banner.getAttribute("data-urgent")).toBe("false");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(banner.getAttribute("data-urgent")).toBe("true");
  } finally {
    vi.useRealTimers();
  }
});
