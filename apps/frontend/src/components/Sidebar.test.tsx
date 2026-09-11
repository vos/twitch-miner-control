import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Sidebar } from "./Sidebar.js";
import { renderApp } from "../test-utils.js";

const view = (version: string | null, latestVersion: string | null = null) =>
  renderApp(
    <Sidebar
      screen="dashboard"
      onNavigate={() => {}}
      liveCount={0}
      loginRequired={false}
      miner={{ state: "RUNNING", startedAt: null }}
      onMinerChange={() => {}}
      version={version}
      latestVersion={latestVersion}
    />,
  );

test("shows the version as a link to the repository", () => {
  view("1.1.0");
  const link = screen.getByTestId("app-version");
  expect(link).toHaveTextContent("v1.1.0");
  expect(link).toHaveAttribute("href", "https://github.com/vos/twitch-miner-control");
});

test("opens the repository safely in a new tab", () => {
  view("1.1.0");
  const link = screen.getByTestId("app-version");
  expect(link).toHaveAttribute("target", "_blank");
  // Without noopener the opened page gets a handle on this one via
  // window.opener.
  expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
});

test("names a dev build rather than pretending to a release number", () => {
  view("dev");
  expect(screen.getByTestId("app-version")).toHaveTextContent("dev build");
});

test("renders nothing before the first status poll answers", () => {
  view(null);
  expect(screen.queryByTestId("app-version")).not.toBeInTheDocument();
});

test("flags a newer release beside the running version", () => {
  view("1.1.0", "1.2.0");
  expect(screen.getByTestId("update-available")).toHaveTextContent("1.2.0");
  // The running version stays put: the badge says what is available, not
  // what is installed.
  expect(screen.getByTestId("app-version")).toHaveTextContent("v1.1.0");
});

test("names the available release for anyone not reading the badge alone", () => {
  view("1.1.0", "1.2.0");
  expect(screen.getByTestId("update-available")).toHaveAttribute(
    "title", "Version 1.2.0 is available",
  );
});

test("points at the releases page, where the upgrade actually is", () => {
  view("1.1.0", "1.2.0");
  const badge = screen.getByTestId("update-available");
  expect(badge).toHaveAttribute(
    "href", "https://github.com/vos/twitch-miner-control/releases",
  );
  expect(badge).toHaveAttribute("rel", expect.stringContaining("noopener"));
});

test("shows no badge when the running version is the latest", () => {
  view("1.1.0", null);
  expect(screen.queryByTestId("update-available")).not.toBeInTheDocument();
});

test("shows no badge on a dev build", () => {
  // The backend never offers one for an unreleased build, but the prop is
  // wire data -- the component must not render a notice next to "dev
  // build" if one ever arrives.
  view("dev", null);
  expect(screen.queryByTestId("update-available")).not.toBeInTheDocument();
});
