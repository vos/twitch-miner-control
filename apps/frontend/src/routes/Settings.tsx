import {
  Alert, Card, Divider, Radio, SegmentedControl, Stack, Switch, Text, Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import {
  GQL_FIELDS, MinerNumberGroup, type NumberFieldSpec, WEEKLY_REWARDS_FIELDS,
} from "../components/MinerNumberGroup.js";
import { PendingBar } from "../components/PendingBar.js";
import { PriorityList } from "../components/PriorityList.js";
import { SettingsFieldRow } from "../components/SettingsFieldRow.js";
import { withKey } from "../components/StreamerSettingsModal.js";
import { SETTINGS_FIELDS } from "../lib/settingsFields.js";

/**
 * "Attempts 3, retry delay 1" -- upstream's defaults for a whole options
 * object, read off the same field table the inputs use so the summary
 * cannot drift from the placeholders.
 */
const defaultSummary = (fields: NumberFieldSpec[]) =>
  fields.map((f) => `${f.label.toLowerCase()} ${f.defaultValue}`).join(", ");

/** The three states upstream distinguishes for `weeklyRewards`. */
type WeeklyMode = "default" | "off" | "custom";

const weeklyModeOf = (value: unknown): WeeklyMode => {
  if (value === false) return "off";
  if (value !== null && typeof value === "object") return "custom";
  return "default";
};

interface Config {
  version: 1; username: string; followers: boolean; followersOrder: string;
  defaults: Record<string, unknown>;
  miner: Record<string, unknown>;
  streamers: Array<{ username: string; enabled: boolean; settings: Record<string, unknown> }>;
}

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

  // The two optional miner-wide objects, read once. `undefined` means the
  // key is absent, which upstream reads as "use my own default" -- for
  // weeklyRewards that is a third state distinct from `false` (disabled).
  const gql = draft.miner.gql as Record<string, unknown> | undefined;
  const weeklyRaw = draft.miner.weeklyRewards;
  const weeklyMode = weeklyModeOf(weeklyRaw);
  const weekly = weeklyMode === "custom"
    ? (weeklyRaw as Record<string, unknown>)
    : undefined;

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
        {/*
          `priority` is an *ordered* list: the miner consults each rule from
          first to last (upstream's PrioritySelector, and
          docs/guides/advanced-configuration.md). An empty selection drops
          the key entirely, which is how upstream is told to use its own
          built-in ordering -- not the same as sending an empty list.
        */}
        <PriorityList
          value={(draft.miner.priority as string[] | undefined) ?? []}
          onChange={(next) => setDraft({
            ...draft,
            miner: withKey(draft.miner, "priority",
              next.length > 0 ? next : undefined),
          })}
        />
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
      <Card withBorder padding="md">
        <Title order={4} mb="xs">Twitch API retries</Title>
        <Text size="sm" c="dimmed" mb="md">
          How hard the miner tries a failing Twitch API request. Leave off to
          use the built-in strategy.
        </Text>
        {/*
          The schema requires both fields once `gql` is present, so enabling
          seeds both upstream defaults rather than an empty object -- and
          `dropWhenEmpty` stays off, or clearing one input would silently
          discard the other.
        */}
        {/* The defaults are worth stating even while the control is off:
            otherwise "off" says nothing about what the miner actually does. */}
        {gql === undefined && (
          <Text size="sm" c="dimmed" mb="sm" data-testid="gql-default">
            Built-in: {defaultSummary(GQL_FIELDS)}.
          </Text>
        )}
        <Switch
          label="Customise retries"
          checked={gql !== undefined}
          onChange={(e) => setDraft({
            ...draft,
            miner: withKey(draft.miner, "gql",
              e.currentTarget.checked
                ? { attempts: 3, attemptIntervalSeconds: 1 }
                : undefined),
          })}
        />
        {gql !== undefined && (
          <>
            <Divider my="md" />
            <MinerNumberGroup
              fields={GQL_FIELDS}
              value={gql}
              onChange={(next) => setDraft({
                ...draft, miner: withKey(draft.miner, "gql", next),
              })}
            />
          </>
        )}
      </Card>
      <Card withBorder padding="md">
        <Title order={4} mb="xs">Weekly rewards</Title>
        <Text size="sm" c="dimmed" mb="md">
          How the miner earns Weekly Rewards progress, by watching a clip and
          then a VOD when a channel is offline.
        </Text>
        {/*
          Three states, not a switch: an absent key takes upstream's own
          BasicConfiguration, `false` disables progression entirely, and an
          object tunes it. Collapsing "default" and "off" together would
          turn one into the other.
        */}
        {weeklyMode === "default" && (
          <Text size="sm" c="dimmed" mb="sm" data-testid="weekly-default">
            Built-in: {defaultSummary(WEEKLY_REWARDS_FIELDS)}.
          </Text>
        )}
        <SegmentedControl
          data={[
            { value: "default", label: "Built-in" },
            { value: "custom", label: "Customise" },
            { value: "off", label: "Disabled" },
          ]}
          value={weeklyMode}
          onChange={(mode) => setDraft({
            ...draft,
            miner: withKey(draft.miner, "weeklyRewards",
              mode === "off" ? false : mode === "custom" ? {} : undefined),
          })}
        />
        {weeklyMode === "custom" && (
          <>
            <Divider my="md" />
            {/*
              `dropWhenEmpty`: every field is individually optional, so an
              emptied object means "nothing tuned" -- which is the built-in
              configuration, not an empty override.
            */}
            <MinerNumberGroup
              fields={WEEKLY_REWARDS_FIELDS}
              value={weekly}
              dropWhenEmpty
              onChange={(next) => setDraft({
                ...draft,
                miner: withKey(draft.miner, "weeklyRewards", next ?? {}),
              })}
            />
          </>
        )}
      </Card>
      <PendingBar count={changed ? 1 : 0} onApply={() => void apply()} busy={busy} />
    </Stack>
  );
}
