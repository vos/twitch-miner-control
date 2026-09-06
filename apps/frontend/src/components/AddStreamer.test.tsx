import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { AddStreamer } from "./AddStreamer.js";

const view = (onAdd: (username: string) => Promise<void>) =>
  render(<MantineProvider><AddStreamer onAdd={onAdd} /></MantineProvider>);

test("hands a pasted channel link to onAdd as a bare username", async () => {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  view(onAdd);
  await userEvent.type(
    screen.getByLabelText("Add streamer"),
    "https://www.twitch.tv/mewmiyu{Enter}",
  );
  expect(onAdd).toHaveBeenCalledWith("mewmiyu");
});

test("still accepts a plain username", async () => {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  view(onAdd);
  await userEvent.type(screen.getByLabelText("Add streamer"), "mewmiyu{Enter}");
  expect(onAdd).toHaveBeenCalledWith("mewmiyu");
});

test("clears the field once the add succeeds", async () => {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  view(onAdd);
  const field = screen.getByLabelText("Add streamer");
  await userEvent.type(field, "https://twitch.tv/mewmiyu{Enter}");
  expect(field).toHaveValue("");
});

test("reports unparseable input instead of calling onAdd", async () => {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  view(onAdd);
  await userEvent.type(
    screen.getByLabelText("Add streamer"),
    "https://youtube.com/mewmiyu{Enter}",
  );
  expect(onAdd).not.toHaveBeenCalled();
  expect(screen.getByText("Enter a Twitch username or channel link")).toBeInTheDocument();
});

test("drops the error as soon as the field is edited again", async () => {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  view(onAdd);
  const field = screen.getByLabelText("Add streamer");
  await userEvent.type(field, "ab{Enter}");
  expect(screen.getByText("Enter a Twitch username or channel link")).toBeInTheDocument();
  await userEvent.type(field, "c");
  expect(screen.queryByText("Enter a Twitch username or channel link")).not.toBeInTheDocument();
});
