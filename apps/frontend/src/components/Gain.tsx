import { Text } from "@mantine/core";
import { formatSpan } from "../lib/formatSpan.js";

const nf = new Intl.NumberFormat("en-US");

/**
 * Renders a gain: the card's 24h and stream figures, and the detail
 * dialog's per-range one.
 *
 * `null` means "we have no earlier balance to compare against" -- on the
 * card, only true on the very first poll of a newly added streamer -- and
 * must not render as "+0", which is a confident claim that nothing was
 * earned.
 *
 * `since` carries the start of a window shorter than the nominal one, and
 * replaces the label with the span actually covered. A streamer tracked
 * for three hours has a real gain over a real window; it just is not a
 * day's worth, and saying "3h" reports that without withholding the
 * number until the 24h mark. The same rule covers a channel shown under
 * "30 days" that has only a week of history.
 */
export function Gain({ value, label, since, size = "xs", testId }: {
  value: number | null;
  label: string;
  since?: number | null;
  /** The dialog sets this larger: it annotates a bigger balance. */
  size?: string;
  testId: string;
}) {
  if (value === null) {
    return (
      <Text size={size} c="dimmed" data-testid={testId}>— {label}</Text>
    );
  }
  const sign = value > 0 ? "+" : "";
  const window = since == null ? label : formatSpan(Date.now() - since);
  return (
    <Text
      size={size}
      c={value > 0 ? "teal" : value < 0 ? "red" : "dimmed"}
      data-testid={testId}
    >
      {sign}{nf.format(value)} {window}
    </Text>
  );
}
