import { Badge, Group, NumberInput, Select, Stack, Switch, Text } from "@mantine/core";
import { type SettingsField, describeDefault } from "../lib/settingsFields.js";

export interface SettingsFieldRowProps {
  field: SettingsField;
  /** `undefined` means the key is absent -- inherited, never a sentinel. */
  value: unknown;
  inheritedValue?: unknown;
  canInherit: boolean;
  disabled?: boolean;
  /** Called with `undefined` to clear the key. */
  onChange: (value: unknown) => void;
}

/** What applies right now: the override if set, else what it inherits. */
function effectiveValue(props: SettingsFieldRowProps): unknown {
  if (props.value !== undefined) return props.value;
  return props.canInherit ? props.inheritedValue : props.field.defaultValue;
}

function describeValue(field: SettingsField, value: unknown): string {
  if (field.kind.kind === "optionalNumber" && value === false) {
    return field.kind.offLabel;
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (field.kind.kind === "enum") {
    return field.kind.labels?.[String(value)] ?? String(value);
  }
  return value === undefined ? describeDefault(field) : String(value);
}

export function SettingsFieldRow(props: SettingsFieldRowProps) {
  const { field, value, canInherit, disabled, onChange } = props;
  const overridden = value !== undefined;
  const current = effectiveValue(props);

  const control = () => {
    // An inherit-capable field that is not overridden shows its resolved
    // value as text: an editable control there would imply the edit sticks.
    if (canInherit && !overridden) {
      return <Text size="sm" c="dimmed">{describeValue(field, current)}</Text>;
    }
    switch (field.kind.kind) {
      case "bool":
        return (
          <Switch
            aria-label={field.label}
            checked={current === true}
            disabled={disabled}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        );
      case "enum":
        return (
          <Select
            aria-label={field.label}
            data={field.kind.options.map((v) => ({
              value: v,
              label: field.kind.kind === "enum"
                ? field.kind.labels?.[v] ?? v : v,
            }))}
            value={typeof current === "string" ? current : null}
            disabled={disabled}
            allowDeselect={false}
            onChange={(v) => v !== null && onChange(v)}
            // Wide enough for the longest option label ("Number of
            // predictors", "Implied probability (%)"), which clipped at 180.
            w={230}
          />
        );
      case "number":
        return (
          <NumberInput
            aria-label={field.label}
            value={typeof current === "number" ? current : ""}
            min={field.kind.min}
            max={field.kind.max}
            disabled={disabled}
            onChange={(v) => onChange(typeof v === "number" ? v : undefined)}
            w={120}
          />
        );
      case "optionalNumber": {
        const off = current === false || current === undefined;
        return (
          <Group gap="xs" wrap="nowrap">
            <Switch
              aria-label={`${field.label} enabled`}
              checked={!off}
              disabled={disabled}
              onChange={(e) =>
                onChange(e.currentTarget.checked
                  ? (field.kind.kind === "optionalNumber" ? field.kind.min ?? 1 : 1)
                  : false)}
            />
            {!off && (
              <NumberInput
                aria-label={field.label}
                value={typeof current === "number" ? current : ""}
                min={field.kind.min}
                disabled={disabled}
                onChange={(v) => onChange(typeof v === "number" ? v : false)}
                w={120}
              />
            )}
          </Group>
        );
      }
    }
  };

  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap" py={6}>
      <Stack gap={2} style={{ flex: 1 }}>
        <Group gap="xs">
          <Text size="sm" fw={500}>{field.label}</Text>
          {/* Only where a field can inherit: there the badge says something
              the control cannot -- whether this value is its own or the
              default's. On a plain row it would just restate the value
              sitting in the control beside it. */}
          {canInherit && (
            <Badge
              size="xs" variant="light" data-testid="field-state"
              color={overridden ? "twitch" : "gray"}
            >
              {overridden ? "Overridden" : `Inherit — ${describeValue(field, current)}`}
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed">{field.help}</Text>
      </Stack>
      <Group gap="sm" wrap="nowrap">
        {control()}
        {canInherit && (
          <Switch
            aria-label={`Override ${field.label}`}
            checked={overridden}
            disabled={disabled}
            onChange={(e) =>
              onChange(e.currentTarget.checked ? effectiveValue(props) : undefined)}
          />
        )}
      </Group>
    </Group>
  );
}
