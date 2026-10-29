import {
  Alert, Card, Divider, Radio, SegmentedControl, Stack, Switch, Text, Title,
} from "@mantine/core";
import { useEffect, useId, useState } from "react";
import { api } from "../api/client.js";
import {
  CLIP_VOD_FIELDS, GQL_FIELDS, MinerNumberGroup, type NumberFieldSpec,
} from "../components/MinerNumberGroup.js";
import { PendingBar } from "../components/PendingBar.js";
import { PriorityList } from "../components/PriorityList.js";
import { SettingsFieldRow } from "../components/SettingsFieldRow.js";
import { withKey } from "../components/StreamerSettingsModal.js";
import { countChanges } from "../lib/countSettingsChanges.js";
import { SETTINGS_FIELDS } from "../lib/settingsFields.js";

/**
 * "Attempts 3, retry delay 1" -- upstream's defaults for a whole options
 * object, read off the same field table the inputs use so the summary
 * cannot drift from the placeholders.
 */
const defaultSummary = (fields: NumberFieldSpec[]) =>
  fields.map((f) => `${f.label.toLowerCase()} ${f.defaultValue}`).join(", ");

/**
 * The three states upstream distinguishes for `weeklyRewards` and
 * `watchStreakRecovery`.
 */
type WatcherMode = "default" | "off" | "custom";

const watcherModeOf = (value: unknown): WatcherMode => {
  if (value === false) return "off";
  if (value !== null && typeof value === "object") return "custom";
  return "default";
};

/**
 * A miner-wide option that watches a clip, then a VOD, for channels that
 * are offline: weekly rewards and watch streak recovery, which upstream
 * tunes with the same dataclass.
 *
 * Three states, not a switch: an absent key takes upstream's own
 * BasicConfiguration, `false` disables the feature entirely, and an
 * object tunes it. Collapsing "default" and "off" together would turn one
 * into the other.
 */
function ClipVodWatcherCard({ title, description, testId, value, onChange }: {
  title: string;
  description: string;
  /** Prefix for the built-in summary's test id. */
  testId: string;
  value: unknown;
  onChange: (next: Record<string, unknown> | false | undefined) => void;
}) {
  const titleId = useId();
  const mode = watcherModeOf(value);
  return (
    <Card withBorder padding="md" component="section" aria-labelledby={titleId}>
      <Title order={4} mb="xs" id={titleId}>{title}</Title>
      <Text size="sm" c="dimmed" mb="md">{description}</Text>
      {mode === "default" && (
        <Text size="sm" c="dimmed" mb="sm" data-testid={`${testId}-default`}>
          Built-in: {defaultSummary(CLIP_VOD_FIELDS)}.
        </Text>
      )}
      <SegmentedControl
        data={[
          { value: "default", label: "Built-in" },
          { value: "custom", label: "Customise" },
          { value: "off", label: "Disabled" },
        ]}
        value={mode}
        onChange={(next) => onChange(
          next === "off" ? false : next === "custom" ? {} : undefined)}
      />
      {mode === "custom" && (
        <>
          <Divider my="md" />
          {/*
            `dropWhenEmpty`: every field is individually optional, so an
            emptied object means "nothing tuned" -- which is the built-in
            configuration, not an empty override.
          */}
          <MinerNumberGroup
            fields={CLIP_VOD_FIELDS}
            value={value as Record<string, unknown>}
            dropWhenEmpty
            onChange={(next) => onChange(next ?? {})}
          />
        </>
      )}
    </Card>
  );
}

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

  // Walks to the leaves rather than comparing serialisations: the rows
  // write through `withKey`, which re-appends a key instead of assigning in
  // place, so a reverted field differs only in key order. It also yields a
  // real count, which the bar reports.
  const changes = countChanges(saved, draft);

  // `undefined` means the key is absent, which upstream reads as "use my
  // own default".
  const gql = draft.miner.gql as Record<string, unknown> | undefined;

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
    // A form is read in one column, so the measure is capped rather than
    // left to fill the window: AppShell.Main sets no width, and on a wide
    // monitor every card stretched the full viewport, stranding each
    // control an eye-journey away from the label it belongs to.
    <Stack pb={80} maw={760}>
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
              // A value equal to the built-in default is written as an
              // absent key, not as itself: `withKey` only deletes on
              // `undefined`, so setting a row back to its default would
              // otherwise pin it and leave a pending change that reverting
              // cannot clear. Absent is also what the miner reads as "use
              // the built-in", so the two agree.
              onChange={(v) => setDraft({
                ...draft,
                defaults: withKey(draft.defaults, field.key,
                  v === field.defaultValue ? undefined : v),
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
      <ClipVodWatcherCard
        title="Weekly rewards"
        description="How the miner earns Weekly Rewards progress, by watching a clip and then a VOD when a channel is offline."
        testId="weekly"
        value={draft.miner.weeklyRewards}
        onChange={(next) => setDraft({
          ...draft, miner: withKey(draft.miner, "weeklyRewards", next),
        })}
      />
      <ClipVodWatcherCard
        title="Watch streak recovery"
        description="How the miner keeps a watch streak alive after missing a stream, by watching a clip or the VOD from it. Only for streamers with watch streaks on."
        testId="recovery"
        value={draft.miner.watchStreakRecovery}
        onChange={(next) => setDraft({
          ...draft, miner: withKey(draft.miner, "watchStreakRecovery", next),
        })}
      />
      <PendingBar count={changes} onApply={() => void apply()} busy={busy} />
    </Stack>
  );
}
