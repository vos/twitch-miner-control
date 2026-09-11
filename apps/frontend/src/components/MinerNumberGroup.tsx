import { Group, NumberInput, Stack, Text } from "@mantine/core";

/** One tunable number inside a miner-wide options object. */
export interface NumberFieldSpec {
  key: string;
  label: string;
  help: string;
  /** Upstream's own default, shown as the placeholder when the key is unset. */
  defaultValue: number;
  min?: number;
  /** Whether upstream accepts 0 (nonnegative) or requires more (positive). */
  allowZero?: boolean;
}

interface Props {
  fields: NumberFieldSpec[];
  /** The options object, or undefined when the key is absent entirely. */
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
  /**
   * Whether clearing the last field collapses the object away. `gql`
   * requires both of its fields, so it keeps the object; `weeklyRewards`
   * takes any subset, so an emptied object is dropped back to "upstream
   * default" rather than being sent as `{}`.
   */
  dropWhenEmpty?: boolean;
  disabled?: boolean;
}

/**
 * The number fields of a miner-wide options object.
 *
 * Every field is individually optional: an empty input means "key absent",
 * which upstream reads as its own default for that one field rather than
 * zero. So the placeholder carries the upstream default and a cleared
 * input deletes the key instead of writing 0 -- the distinction the
 * backend schema draws between an omitted field and a supplied one.
 */
export function MinerNumberGroup(
  { fields, value, onChange, dropWhenEmpty, disabled }: Props,
) {
  const set = (key: string, next: number | undefined) => {
    const base = { ...(value ?? {}) };
    if (next === undefined) delete base[key];
    else base[key] = next;
    if (dropWhenEmpty && Object.keys(base).length === 0) {
      onChange(undefined);
      return;
    }
    onChange(base);
  };

  return (
    <Stack gap="sm">
      {fields.map((field) => {
        const current = value?.[field.key];
        return (
          <Group key={field.key} justify="space-between" align="flex-start" wrap="nowrap">
            <Stack gap={2} style={{ flex: 1 }}>
              <Text size="sm" fw={500}>{field.label}</Text>
              <Text size="xs" c="dimmed">{field.help}</Text>
            </Stack>
            <NumberInput
              aria-label={field.label}
              value={typeof current === "number" ? current : ""}
              placeholder={String(field.defaultValue)}
              min={field.min ?? (field.allowZero ? 0 : 1)}
              disabled={disabled}
              onChange={(v) => set(field.key, typeof v === "number" ? v : undefined)}
              w={120}
            />
          </Group>
        );
      })}
    </Stack>
  );
}

/**
 * `gql`: how the miner retries Twitch GQL requests. Defaults from
 * AttemptStrategy (vendor/miner/.../utils/AttemptStrategy.py).
 */
export const GQL_FIELDS: NumberFieldSpec[] = [
  {
    key: "attempts", label: "Attempts", defaultValue: 3, min: 1,
    help: "How many times to try each Twitch API request before giving up. "
      + "Must be at least 1 to make any request at all.",
  },
  {
    key: "attemptIntervalSeconds", label: "Retry delay", defaultValue: 1,
    allowZero: true,
    help: "Seconds to wait between attempts.",
  },
];

/**
 * `weeklyRewards`: how the miner progresses Weekly Rewards. Field names and
 * defaults come from the BasicConfiguration dataclass
 * (vendor/miner/.../classes/ClipVodWatcher.py), NOT from example.py or the
 * upstream guide -- both of those document stale names, and the guide also
 * says max_concurrent is 2 where the dataclass says 3.
 */
export const WEEKLY_REWARDS_FIELDS: NumberFieldSpec[] = [
  {
    key: "maxConcurrent", label: "Concurrent channels", defaultValue: 3, min: 1,
    help: "How many channels to progress at the same time.",
  },
  {
    key: "maxClipWatchSeconds", label: "Clip watch seconds", defaultValue: 30, min: 1,
    help: "Seconds of a clip to watch. Watching a clip usually earns the progress "
      + "on its own.",
  },
  {
    key: "maxVodWatchSeconds", label: "VOD watch seconds", defaultValue: 480, min: 1,
    help: "Seconds of a VOD to watch, tried only when the clip did not earn progress.",
  },
  {
    key: "intervalSeconds", label: "Check interval", defaultValue: 20, min: 1,
    help: "Seconds between checks for a channel needing progress.",
  },
  {
    key: "maxFailuresPerStreamer", label: "Failures before cooldown",
    defaultValue: 1, allowZero: true,
    help: "Failed attempts allowed per channel before it is put on cooldown.",
  },
  {
    key: "failureCooldownSeconds", label: "Cooldown seconds",
    defaultValue: 3600, allowZero: true,
    help: "Seconds a channel stays on cooldown, during which no progress is attempted.",
  },
];
