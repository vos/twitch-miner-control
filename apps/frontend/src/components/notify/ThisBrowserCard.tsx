import { Anchor, Badge, Button, Card, Group, Stack, Text, TextInput, Title } from "@mantine/core";
import type { ReactNode } from "react";
import type { Destination, DestinationPatch } from "../../api/notify.js";
import type { PushSupport } from "../../lib/push.js";
import { TestButton } from "./TestButton.js";

const HTTPS_HELP = "https://github.com/vos/twitch-miner-control#putting-it-behind-a-reverse-proxy";

/** What stands in the way, in words the user can act on. */
const BLOCKERS: Record<Exclude<PushSupport, "ok">, ReactNode> = {
  insecure: (
    <>
      Browser notifications need HTTPS, or the app opened on localhost.{" "}
      <Anchor href={HTTPS_HELP} target="_blank" rel="noopener noreferrer">
        Set up HTTPS with a reverse proxy
      </Anchor>
      . The bell's inbox works either way.
    </>
  ),
  "ios-install": (
    <>
      On iPhone and iPad, notifications only work once the app is on the Home Screen. Tap Share,
      then Add to Home Screen, and open it from there.
    </>
  ),
  unsupported: <>This browser can't receive push notifications. The bell's inbox still works.</>,
  denied: (
    <>
      Notifications are blocked for this site. Allow them in the browser's site settings, then
      reload this page.
    </>
  ),
};

export function ThisBrowserCard({
  support, destination, busy, onTurnOn, onTurnOff, onSave, onTest,
}: {
  support: PushSupport;
  destination: Destination | null;
  busy: boolean;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onSave: (patch: DestinationPatch) => void;
  onTest: () => Promise<string | null>;
}) {
  return (
    <Card withBorder>
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={4}>This browser</Title>
          {destination !== null && (
            <Badge variant="light" color={destination.enabled ? "green" : "gray"}>
              {destination.enabled ? "On" : "Paused"}
            </Badge>
          )}
        </Group>
        {support !== "ok" && <Text size="sm" c="dimmed">{BLOCKERS[support]}</Text>}
        {destination === null && support === "ok" && (
          <>
            <Text size="sm">
              Get notified about crashes, drops and restarts even with this tab closed. Once it's on,
              choose which events below.
            </Text>
            <Group>
              <Button onClick={onTurnOn} loading={busy}>Turn on notifications</Button>
            </Group>
          </>
        )}
        {destination !== null && (
          <>
            <TextInput
              label="Name"
              description="How this browser is listed on your other devices."
              defaultValue={destination.label}
              maxLength={60}
              onBlur={(event) => {
                const label = event.currentTarget.value.trim();
                if (label !== "" && label !== destination.label) onSave({ label });
              }}
            />
            <Group>
              <Button variant="default" onClick={() => onSave({ enabled: !destination.enabled })}>
                {destination.enabled ? "Pause" : "Resume"}
              </Button>
              <TestButton onTest={onTest} />
              <Button variant="subtle" color="red" onClick={onTurnOff} loading={busy}>Turn off</Button>
            </Group>
            {destination.lastError !== null && (
              <Text size="sm" c="red">Last delivery failed: {destination.lastError}</Text>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
