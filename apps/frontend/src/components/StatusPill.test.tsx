import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { StatusPill } from "./StatusPill.js";
import { renderApp } from "../test-utils.js";

test("a live channel reads LIVE with how long it has been up", () => {
  renderApp(
    <StatusPill isOnline={true} liveSince={Date.now() - 2 * 60 * 60 * 1000} lastLive={null} />,
  );
  expect(screen.getByTestId("live-pill")).toHaveTextContent("LIVE 2h");
});

test("a live channel with no start time still reads LIVE", () => {
  // liveSince is absent on a channel the miner saw go online without a
  // stream record; the state is still known, so the pill must not vanish.
  renderApp(<StatusPill isOnline={true} liveSince={null} lastLive={null} />);
  expect(screen.getByTestId("live-pill")).toHaveTextContent("LIVE");
});

test("an offline channel carries the time since it was last seen live", () => {
  renderApp(
    <StatusPill
      isOnline={false}
      liveSince={null}
      lastLive={Date.now() - 3 * 24 * 60 * 60 * 1000}
    />,
  );
  expect(screen.getByTestId("offline-pill")).toHaveTextContent("OFFLINE 3d");
});

test("a channel never seen live reads a bare OFFLINE", () => {
  // Distinct from the no-data case below: this is a real observation --
  // we have watched it and never caught it live -- so it gets a pill.
  renderApp(<StatusPill isOnline={false} liveSince={null} lastLive={null} />);
  const pill = screen.getByTestId("offline-pill");
  expect(pill).toHaveTextContent("OFFLINE");
  expect(pill.textContent?.trim()).toBe("OFFLINE");
});

test("renders nothing at all when the state is unknown", () => {
  // isOnline null means the miner never reported on this channel. A pill
  // here would assert "offline", which is a claim we cannot make.
  const { container } = renderApp(
    <StatusPill isOnline={null} liveSince={null} lastLive={null} />,
  );
  expect(container.querySelector("[data-testid$='-pill']")).toBeNull();
});
