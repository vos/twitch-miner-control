import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Sidebar } from "./Sidebar.js";
import { renderApp } from "../test-utils.js";

const view = (version: string | null) =>
  renderApp(
    <Sidebar
      screen="dashboard"
      onNavigate={() => {}}
      liveCount={0}
      loginRequired={false}
      miner={{ state: "RUNNING", startedAt: null }}
      onMinerChange={() => {}}
      version={version}
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
