import { Alert, Modal, Stack, Switch, Tabs, Text } from "@mantine/core";
import {
  BET_FIELDS, FILTER_FIELDS, SETTINGS_FIELDS, type TabId,
} from "../lib/settingsFields.js";
import { SettingsFieldRow } from "./SettingsFieldRow.js";

export interface StreamerSettingsModalProps {
  username: string;
  opened: boolean;
  settings: Record<string, unknown>;
  defaults: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
  onClose: () => void;
}

const DEFAULT_FILTER = { by: "total_users", where: "LTE", value: 800 };

/** Sets or, for `undefined`, deletes a key -- absent means inherited. */
export function withKey(
  source: Record<string, unknown>, key: string, value: unknown,
): Record<string, unknown> {
  const next = { ...source };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

export function StreamerSettingsModal(props: StreamerSettingsModalProps) {
  const { username, opened, settings, defaults, onChange, onClose } = props;

  const bet = (settings.bet ?? {}) as Record<string, unknown>;
  const defaultBet = (defaults.bet ?? {}) as Record<string, unknown>;
  const filter = bet.filterCondition as Record<string, unknown> | undefined;

  // An emptied bet block is dropped rather than left as `bet: {}`, which
  // would read as an override of the default bet with nothing in it.
  const setBet = (key: string, value: unknown) => {
    const nextBet = withKey(bet, key, value);
    onChange(withKey(settings, "bet",
      Object.keys(nextBet).length > 0 ? nextBet : undefined));
  };

  // Predictions are meaningless when the streamer does not bet. The
  // resolved value decides, so inheriting `false` disables them too.
  const bets = (settings.makePredictions ?? defaults.makePredictions ?? true) === true;

  const rows = (tab: TabId) =>
    SETTINGS_FIELDS.filter((f) => f.tab === tab).map((field) => (
      <SettingsFieldRow
        key={field.key}
        field={field}
        value={settings[field.key]}
        inheritedValue={defaults[field.key] ?? field.defaultValue}
        canInherit
        onChange={(v) => onChange(withKey(settings, field.key, v))}
      />
    ));

  return (
    <Modal opened={opened} onClose={onClose} title={`Settings — ${username}`} size="lg">
      {/* The modal header sits directly on the tab row otherwise -- the
          title and the tabs read as one block. */}
      <Tabs defaultValue="general" mt="md">
        <Tabs.List>
          <Tabs.Tab value="general">General</Tabs.Tab>
          <Tabs.Tab value="points">Points &amp; chat</Tabs.Tab>
          <Tabs.Tab value="predictions">Predictions</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="general">
          <Stack gap={0} pt="md">{rows("general")}</Stack>
        </Tabs.Panel>
        <Tabs.Panel value="points">
          <Stack gap={0} pt="md">{rows("points")}</Stack>
        </Tabs.Panel>

        <Tabs.Panel value="predictions">
          <Stack gap={0} pt="md">
            {!bets && (
              <Alert color="gray" data-testid="predictions-disabled-note" mb="sm">
                Predictions are off for this streamer. Turn on “Make predictions”
                under General to configure betting.
              </Alert>
            )}
            {BET_FIELDS.map((field) => (
              <SettingsFieldRow
                key={field.key}
                field={field}
                value={bet[field.key]}
                inheritedValue={defaultBet[field.key] ?? field.defaultValue}
                canInherit
                disabled={!bets}
                onChange={(v) => setBet(field.key, v)}
              />
            ))}
            <Switch
              mt="md"
              label="Only bet when…"
              description="Skip the bet unless the outcome matches this condition."
              checked={filter !== undefined}
              disabled={!bets}
              onChange={(e) =>
                setBet("filterCondition",
                  e.currentTarget.checked ? DEFAULT_FILTER : undefined)}
            />
            {/* The condition is all-or-nothing -- it exists or it does not
                -- so its three parts are plain controls rather than
                inherit-capable rows. */}
            {filter && (
              <Stack gap={0} pl="xl">
                {FILTER_FIELDS.map((field) => (
                  <SettingsFieldRow
                    key={field.key}
                    field={field}
                    value={filter[field.key] ?? field.defaultValue}
                    canInherit={false}
                    disabled={!bets}
                    onChange={(v) => setBet("filterCondition",
                      { ...filter, [field.key]: v })}
                  />
                ))}
              </Stack>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}
