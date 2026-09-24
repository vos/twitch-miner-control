import { MantineProvider } from "@mantine/core";
import { screen } from "@testing-library/react";
import { vi, expect, test } from "vitest";
import { renderApp } from "../../test-utils.js";
import { theme } from "../../theme.js";
import type { Destination } from "../../api/notify.js";
import { ThisBrowserCard } from "./ThisBrowserCard.js";

const destination = (over: Partial<Destination> = {}): Destination => ({
  id: "d1", channel: "webpush", label: "Chrome", endpoint: "https://push.example/a",
  prefs: { kinds: {}, streamers: "all", quietHours: null, timeZone: "UTC", digestAt: "09:00" },
  enabled: true, createdTs: 1, lastOkTs: null, lastError: null, lastErrorTs: null, ...over,
});

const noop = () => {};
const view = (dest: Destination) =>
  renderApp(
    <ThisBrowserCard
      support="ok"
      destination={dest}
      busy={false}
      onTurnOn={noop}
      onTurnOff={noop}
      onSave={noop}
      onTest={async () => null}
    />,
  );

test("an external rename replaces the field's value", () => {
  const { rerender } = view(destination({ label: "Chrome" }));
  expect(screen.getByLabelText("Name")).toHaveValue("Chrome");
  // The field is uncontrolled (defaultValue), so without a key tied to the
  // label it would keep showing what the user last saw, not the rename
  // another device or process made.
  rerender(
    <MantineProvider theme={theme} forceColorScheme="dark">
      <ThisBrowserCard
        support="ok"
        destination={destination({ label: "Living Room TV" })}
        busy={false}
        onTurnOn={noop}
        onTurnOff={noop}
        onSave={noop}
        onTest={async () => null}
      />
    </MantineProvider>,
  );
  expect(screen.getByLabelText("Name")).toHaveValue("Living Room TV");
});

test("a save fires only when the trimmed label actually changed", () => {
  const onSave = vi.fn();
  renderApp(
    <ThisBrowserCard
      support="ok"
      destination={destination({ label: "Chrome" })}
      busy={false}
      onTurnOn={noop}
      onTurnOff={noop}
      onSave={onSave}
      onTest={async () => null}
    />,
  );
  screen.getByLabelText("Name").blur();
  expect(onSave).not.toHaveBeenCalled();
});
