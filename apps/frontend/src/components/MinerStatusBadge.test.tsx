import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { MinerStatusBadge } from "./MinerStatusBadge.js";

test("shows the miner state", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={null} />);
  expect(screen.getByTestId("miner-state")).toHaveTextContent("RUNNING");
});

test("shows a placeholder, not a state, until the first poll answers", () => {
  // An orange badge reading "…" claims the miner is down before anything
  // has said so.
  renderApp(<MinerStatusBadge state={null} startedAt={null} />);
  expect(screen.queryByTestId("miner-state")).not.toBeInTheDocument();
  expect(screen.getByTestId("miner-state-loading")).toBeInTheDocument();
});

test("shows uptime when the miner is up", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={Date.now() - 90_000} />);
  // Rendered "1m30s": each number is welded to its unit so the figures
  // read as three objects rather than one sentence. The title and the
  // detail panel both keep the spaced form.
  expect(screen.getByTestId("miner-uptime")).toHaveTextContent("1m30s");
});

test("shows no uptime when nothing is running", () => {
  renderApp(<MinerStatusBadge state="STOPPED" startedAt={null} />);
  expect(screen.queryByTestId("miner-uptime")).not.toBeInTheDocument();
});

test("carries no action buttons -- those live in the sidebar dock", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={null} />);
  expect(screen.queryByTestId("miner-toggle")).not.toBeInTheDocument();
  expect(screen.queryByTestId("miner-restart")).not.toBeInTheDocument();
});

const history = (cpus: (number | null)[]) =>
  cpus.map((cpu, i) => ({ at: i * 1000, cpu, rssBytes: 148 * 1024 * 1024 }));

test("shows cpu and memory for a running miner", () => {
  renderApp(
    <MinerStatusBadge state="RUNNING" startedAt={null} history={history([10, 20])} />,
  );
  expect(screen.getByTestId("miner-stats")).toHaveTextContent("15%");
  // The space is dropped so the digits and their unit read as one object.
  expect(screen.getByTestId("miner-stats")).toHaveTextContent("148MB");
});

test("keeps the average's window off the line but states it in the title", () => {
  renderApp(
    <MinerStatusBadge state="RUNNING" startedAt={null} history={history([10, 20])} />,
  );
  // "2% 1m avg" was the phrase that made the readout parse as one
  // sentence, and it qualifies a figure rather than being one.
  expect(screen.getByTestId("miner-stats")).not.toHaveTextContent("avg");
  // Two samples is 10 seconds of history, not the minute it settles on.
  expect(screen.getByTestId("miner-cpu")).toHaveAttribute(
    "title", "CPU, 10s avg: 15%",
  );
});

test("shows memory before any cpu figure can be computed", () => {
  renderApp(
    <MinerStatusBadge state="RUNNING" startedAt={null} history={history([null])} />,
  );
  // Memory is an instantaneous read, so it is there from the first poll
  // even though cpu needs a second sample to form a delta.
  expect(screen.getByTestId("miner-stats")).toHaveTextContent("148MB");
  expect(screen.getByTestId("miner-stats")).not.toHaveTextContent("%");
});

test("shows no stats when the miner is not running", () => {
  renderApp(<MinerStatusBadge state="STOPPED" startedAt={null} history={[]} />);
  expect(screen.queryByTestId("miner-stats")).not.toBeInTheDocument();
});

test("graphs the cpu history once there is a trend to draw", () => {
  renderApp(
    <MinerStatusBadge state="RUNNING" startedAt={null} history={history([10, 20, 30])} />,
  );
  expect(screen.getByTestId("miner-cpu-graph")).toBeInTheDocument();
});

test("draws no graph from a single reading", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={null} history={history([10])} />);
  // One point is not a trend; the numbers still show.
  expect(screen.queryByTestId("miner-cpu-graph")).not.toBeInTheDocument();
  expect(screen.getByTestId("miner-stats")).toBeInTheDocument();
});

/**
 * The width tiering is CSS media queries, which jsdom does not evaluate,
 * so these assert which tier each figure was assigned rather than what a
 * given viewport renders -- the part that can silently regress in a
 * refactor. That the tiers reveal at the right widths is a browser
 * behaviour, checked by measuring a real header.
 *
 * The class names come from the CSS module, so a renamed or deleted tier
 * fails here rather than silently leaving a figure visible at every width
 * (an undefined `classes.x` renders as no class at all).
 */
const ALWAYS = ["miner-state", "miner-cpu"];
const TIERED: [string, string][] = [
  ["miner-uptime", "fromUptime"],
  ["miner-memory", "fromMemory"],
];

test("keeps the state and cpu figure at every width", () => {
  renderApp(
    <MinerStatusBadge
      state="RUNNING"
      startedAt={Date.now() - 90_000}
      history={history([10, 20])}
    />,
  );
  // These two answer "is it working, and how hard" -- the reason the
  // readout is in the header at all.
  for (const id of ALWAYS) {
    const el = screen.getByTestId(id);
    expect(el.className).not.toMatch(/\bfrom[A-Z]/);
  }
});

test("reveals the remaining figures one tier at a time, not all at once", () => {
  renderApp(
    <MinerStatusBadge
      state="RUNNING"
      startedAt={Date.now() - 90_000}
      history={history([10, 20])}
    />,
  );
  // Each figure sits on its own threshold. Sharing one breakpoint made
  // the header binary: bare percentage, then everything at 768px.
  const seen = new Set<string>();
  for (const [id, tier] of TIERED) {
    const el = screen.getByTestId(id);
    expect(el.className).toMatch(new RegExp(`\\b\\S*${tier}\\S*\\b`));
    seen.add(tier);
  }
  expect(seen.size).toBe(TIERED.length);
});

test("opens the detail panel on tap, not hover alone", async () => {
  const user = userEvent.setup();
  renderApp(
    <MinerStatusBadge
      state="RUNNING"
      startedAt={Date.now() - 90_000}
      history={history([10, 20])}
    />,
  );
  expect(screen.queryByTestId("miner-stats-detail")).not.toBeInTheDocument();

  // A touch device fires no hover, so the panel must open on click --
  // this is the only route to the figures the header hides.
  await user.click(screen.getByTestId("miner-stats"));
  expect(await screen.findByTestId("miner-stats-detail")).toBeInTheDocument();
});

test("the detail panel carries every figure, including the visible ones", async () => {
  const user = userEvent.setup();
  renderApp(
    <MinerStatusBadge
      state="RUNNING"
      startedAt={Date.now() - 90_000}
      history={history([10, 20])}
    />,
  );
  await user.click(screen.getByTestId("miner-stats"));
  const detail = await screen.findByTestId("miner-stats-detail");

  // Listing only the hidden figures would make the panel's contents
  // depend on the width it was opened at.
  expect(detail).toHaveTextContent("15%");
  expect(detail).toHaveTextContent("10s avg");
  expect(detail).toHaveTextContent("148 MB");
  expect(detail).toHaveTextContent("1m 30s");
});

test("splits each figure into bright digits and a dimmed unit", () => {
  renderApp(
    <MinerStatusBadge
      state="RUNNING"
      startedAt={Date.now() - 90_000}
      history={history([10, 20])}
    />,
  );
  // What separates the three readings, in place of colour: the palette's
  // meanings are already spent (green is a gain, red is live), and these
  // are neutral figures.
  const memory = screen.getByTestId("miner-memory");
  const parts = [...memory.querySelectorAll("span")].map((s) => s.textContent);
  expect(parts).toEqual(["148", "MB"]);

  const [digits, unit] = [...memory.querySelectorAll("span")];
  expect(digits.className).toMatch(/value/);
  expect(unit.className).toMatch(/unit/);
});

test("splits a compound duration on every unit boundary", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={Date.now() - 90_000} />);
  const parts = [...screen.getByTestId("miner-uptime").querySelectorAll("span")]
    .map((s) => s.textContent);
  // "1m 30s" -> the space is dropped, so each number welds to its unit.
  expect(parts).toEqual(["1", "m", "30", "s"]);
});

test("every figure keeps a spelled-out title", () => {
  renderApp(
    <MinerStatusBadge
      state="RUNNING"
      startedAt={Date.now() - 90_000}
      history={history([10, 20])}
    />,
  );
  // Dimming a unit makes the line scannable but terser; the title keeps
  // the meaning reachable without opening the panel.
  expect(screen.getByTestId("miner-uptime")).toHaveAttribute("title", "Uptime: 1m 30s");
  expect(screen.getByTestId("miner-memory")).toHaveAttribute("title", "Memory: 148 MB");
});

test("the sparkline sits with the cpu figure it plots", () => {
  renderApp(
    <MinerStatusBadge
      state="RUNNING"
      startedAt={null}
      history={history([10, 20, 30])}
    />,
  );
  // At the far right, past memory, the line read as a third unrelated
  // figure rather than as this percentage's own trend.
  const cpu = screen.getByTestId("miner-cpu");
  const graph = screen.getByTestId("miner-cpu-graph");
  const memory = screen.getByTestId("miner-memory");
  expect(cpu.parentElement).toBe(graph.parentElement?.parentElement);
  expect(memory.parentElement).not.toBe(cpu.parentElement);
});

test("the stats readout is a labelled control, not a bare hover target", () => {
  renderApp(
    <MinerStatusBadge state="RUNNING" startedAt={null} history={history([10, 20])} />,
  );
  // Reachable by keyboard and announced as opening something, since on a
  // phone it guards figures that appear nowhere else.
  const target = screen.getByRole("button", { name: "Miner performance detail" });
  expect(target).toBe(screen.getByTestId("miner-stats"));
});
