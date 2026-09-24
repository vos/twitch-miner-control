import {
  Card, Checkbox, Group, MultiSelect, SegmentedControl, Stack, Switch, Text, TextInput, Title,
} from "@mantine/core";
import type { KindInfo, NotifyConfig, Prefs } from "../../api/notify.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIGEST = "digest.daily";

type Change = (prefs: Prefs) => void;

/** One destination's choices. Every change is saved as it is made. */
export function PrefsEditor({ config, heading, prefs, roster, onChange }: {
  config: NotifyConfig;
  heading: string;
  prefs: Prefs;
  /** Streamers to offer for the "went live" filter. */
  roster: Array<{ value: string; label: string }>;
  onChange: Change;
}) {
  const on = (k: Pick<KindInfo, "kind" | "defaultOn">) => prefs.kinds[k.kind] ?? k.defaultOn;
  const setKind = (kind: string, value: boolean) =>
    onChange({ ...prefs, kinds: { ...prefs.kinds, [kind]: value } });
  const digest = config.catalogue.find((k) => k.kind === DIGEST);

  return (
    <Card withBorder>
      <Stack gap="md">
        <Title order={4}>{heading}</Title>
        {config.groups.map((group) => {
          const kinds = config.catalogue.filter((k) => k.group === group.id);
          if (kinds.length === 0) return null;
          return (
            <Stack key={group.id} gap="xs">
              <Text fw={600} size="sm">{group.label}</Text>
              {kinds.map((k) => (
                <Switch
                  key={k.kind}
                  label={k.label}
                  description={k.description}
                  checked={on(k)}
                  onChange={(event) => setKind(k.kind, event.currentTarget.checked)}
                />
              ))}
              {group.id === "streamers" && (
                <StreamerFilter prefs={prefs} roster={roster} onChange={onChange} />
              )}
              {group.id === "digest" && digest !== undefined && on(digest) && (
                <TextInput
                  type="time"
                  label="Send at"
                  w={140}
                  pl="xl"
                  defaultValue={prefs.digestAt}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (TIME.test(value)) onChange({ ...prefs, digestAt: value });
                  }}
                />
              )}
            </Stack>
          );
        })}
        <QuietHoursField prefs={prefs} onChange={onChange} />
        <Text size="xs" c="dimmed">Times are in {prefs.timeZone}.</Text>
      </Stack>
    </Card>
  );
}

function StreamerFilter({ prefs, roster, onChange }: {
  prefs: Prefs;
  roster: Array<{ value: string; label: string }>;
  onChange: Change;
}) {
  const chosen = prefs.streamers === "all" ? null : prefs.streamers;
  // A chosen streamer no longer in the roster still shows, so it can be removed.
  const data = chosen === null ? roster : [
    ...roster,
    ...chosen.filter((login) => !roster.some((r) => r.value === login))
      .map((login) => ({ value: login, label: login })),
  ];
  return (
    <Stack gap="xs" pl="xl">
      <SegmentedControl
        size="xs"
        w="fit-content"
        value={chosen === null ? "all" : "some"}
        data={[{ value: "all", label: "All streamers" }, { value: "some", label: "Only these" }]}
        onChange={(value) => onChange({ ...prefs, streamers: value === "all" ? "all" : [] })}
      />
      {chosen !== null && (
        <MultiSelect
          aria-label="Streamers to notify about"
          placeholder="Pick streamers"
          searchable
          data={data}
          value={chosen}
          onChange={(logins) => onChange({ ...prefs, streamers: logins })}
        />
      )}
    </Stack>
  );
}

function QuietHoursField({ prefs, onChange }: { prefs: Prefs; onChange: Change }) {
  const quiet = prefs.quietHours;
  return (
    <Stack gap="xs">
      <Switch
        label="Quiet hours"
        description="Nothing is sent in this window. The inbox still records everything."
        checked={quiet !== null}
        onChange={(event) => onChange({
          ...prefs,
          quietHours: event.currentTarget.checked
            ? { from: "22:00", to: "07:00", allowHealth: true }
            : null,
        })}
      />
      {quiet !== null && (
        <Group pl="xl" align="flex-end">
          <TextInput
            type="time" label="From" w={120} defaultValue={quiet.from}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (TIME.test(value)) onChange({ ...prefs, quietHours: { ...quiet, from: value } });
            }}
          />
          <TextInput
            type="time" label="To" w={120} defaultValue={quiet.to}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (TIME.test(value)) onChange({ ...prefs, quietHours: { ...quiet, to: value } });
            }}
          />
          <Checkbox
            label="Let miner problems through"
            checked={quiet.allowHealth}
            onChange={(event) => onChange({
              ...prefs, quietHours: { ...quiet, allowHealth: event.currentTarget.checked },
            })}
          />
        </Group>
      )}
    </Stack>
  );
}
