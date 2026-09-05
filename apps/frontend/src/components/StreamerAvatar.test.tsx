import { expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "../test-utils.js";
import { StreamerAvatar } from "./StreamerAvatar.js";

test("links to the streamer's twitch channel", () => {
  renderApp(<StreamerAvatar login="alpha" displayName="Alpha" avatarUrl={null} />);
  const link = screen.getByRole("link");
  expect(link).toHaveAttribute("href", "https://twitch.tv/alpha");
});

test("opens in a new tab without handing twitch a window handle", () => {
  renderApp(<StreamerAvatar login="alpha" displayName="Alpha" avatarUrl={null} />);
  const link = screen.getByRole("link");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("links by login even when the display name differs", () => {
  // Display names can be non-ASCII and do not resolve as URLs.
  renderApp(<StreamerAvatar login="alpha" displayName="アルファ" avatarUrl={null} />);
  expect(screen.getByRole("link")).toHaveAttribute("href", "https://twitch.tv/alpha");
});

test("renders the image when a url is present", () => {
  // Queried by role "presentation", not "img": the empty alt is
  // deliberate (the name is rendered right beside it), and an
  // alt="" image is exposed as presentational, never as an image.
  const { container } = renderApp(
    <StreamerAvatar login="alpha" displayName="Alpha" avatarUrl="https://cdn/a.png" />,
  );
  expect(container.querySelector("img")).toHaveAttribute("src", "https://cdn/a.png");
  expect(screen.getByRole("presentation")).toHaveAttribute("src", "https://cdn/a.png");
});

test("renders a monogram when there is no url", () => {
  const { container } = renderApp(
    <StreamerAvatar login="alpha" displayName="Alpha" avatarUrl={null} />,
  );
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("A")).toBeInTheDocument();
});

test("falls back to the login when there is no display name", () => {
  renderApp(<StreamerAvatar login="beta" displayName={null} avatarUrl={null} />);
  expect(screen.getByText("B")).toBeInTheDocument();
});

test("labels the link for screen readers", () => {
  // The image itself is decorative -- the name sits right beside it --
  // so the accessible name has to come from the link.
  renderApp(<StreamerAvatar login="alpha" displayName="Alpha" avatarUrl={null} />);
  expect(screen.getByRole("link", { name: /Alpha on Twitch/i })).toBeInTheDocument();
});
