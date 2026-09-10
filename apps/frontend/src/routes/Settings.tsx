import {
  Alert, Card, Checkbox, Radio, Stack, Switch, Text, Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { PendingBar } from "../components/PendingBar.js";
import { SettingsFieldRow } from "../components/SettingsFieldRow.js";
import { withKey } from "../components/StreamerSettingsModal.js";
import { SETTINGS_FIELDS } from "../lib/settingsFields.js";

interface Config {
  version: 1; username: string; followers: boolean; followersOrder: string;
  defaults: Record<string, unknown>;
  miner: Record<string, unknown>;
  streamers: Array<{ username: string; enabled: boolean; settings: Record<string, unknown> }>;
}

/**
 * Priority values, in the order they are offered. Selecting them builds the
 * list the miner reads top-down, so the checkbox order is the priority
 * order. Leaving every box clear sends no `priority` at all, which is how
 * upstream is told to use its own built-in ordering.
 */
const PRIORITY_LABELS: Array<[string, string]> = [
  ["STREAK", "Watch streaks"], ["DROPS", "Drops"], ["SUBSCRIBED", "Subscribed"],
  ["WATCH_SESSION", "Watch session"], ["WEEKLY_REWARDS", "Weekly rewards"],
  ["ORDER", "List order"], ["POINTS_ASCENDING", "Fewest points first"],
  ["POINTS_DESCENDING", "Most points first"],
];

export function Settings() {
  const [saved, setSaved] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Config>("/api/config").then((c) => { setSaved(c); setDraft(c); });
  }, []);

  if (!draft || !saved) return null;

  // A deep comparison rather than field-by-field: the defaults and miner
  // sections hold nested objects, and an edit buried in one of them has to
  // count as a pending change like any other.
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  const apply = async () => {
    setBusy(true);
    try {
      await api.put("/api/config", draft);
      await api.post("/api/config/apply");
      setSaved(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack pb={80}>
      {error && <Alert role="alert" color="red">{error}</Alert>}
      <Card withBorder padding="md">
        <Switch
          label="Mine my followed channels"
          description="Adds every channel you follow on Twitch to the mining list."
          checked={draft.followers}
          onChange={(e) => setDraft({ ...draft, followers: e.currentTarget.checked })}
        />
      </Card>
      <Card withBorder padding="md">
        <Radio.Group
          label="Follower order"
          description="Which followed channels the miner reaches first."
          value={draft.followersOrder}
          onChange={(value) => setDraft({ ...draft, followersOrder: value })}
        >
          <Stack gap="xs" mt="sm">
            <Radio value="ASC" label="Oldest first" />
            <Radio value="DESC" label="Newest first" />
          </Stack>
        </Radio.Group>
      </Card>
      <Card withBorder padding="md">
        <Title order={4} mb="xs">Default streamer settings</Title>
        <Text size="sm" c="dimmed" mb="md">
          Applied to every streamer that does not override the setting itself.
        </Text>
        <Stack gap={0}>
          {SETTINGS_FIELDS.map((field) => (
            <SettingsFieldRow
              key={field.key}
              field={field}
              value={draft.defaults[field.key]}
              canInherit={false}
              onChange={(v) => setDraft({
                ...draft, defaults: withKey(draft.defaults, field.key, v),
              })}
            />
          ))}
        </Stack>
      </Card>
      <Card withBorder padding="md">
        <Title order={4} mb="xs">Miner</Title>
        <Checkbox.Group
          label="Priority"
          description="What the miner reaches for first when choosing which channels to watch. Leave all unchecked for the built-in order."
          value={(draft.miner.priority as string[]) ?? []}
          onChange={(value) => setDraft({
            ...draft,
            miner: withKey(draft.miner, "priority",
              value.length > 0 ? value : undefined),
          })}
        >
          <Stack gap="xs" mt="sm">
            {PRIORITY_LABELS.map(([value, label]) => (
              <Checkbox key={value} value={value} label={label} />
            ))}
          </Stack>
        </Checkbox.Group>
        <Switch
          mt="md"
          label="Claim drops at startup"
          description="Claim everything claimable in your Twitch inventory when the miner starts."
          checked={draft.miner.claimDropsStartup === true}
          onChange={(e) => setDraft({
            ...draft,
            miner: withKey(draft.miner, "claimDropsStartup",
              e.currentTarget.checked || undefined),
          })}
        />
      </Card>
      <PendingBar count={changed ? 1 : 0} onApply={() => void apply()} busy={busy} />
    </Stack>
  );
}
