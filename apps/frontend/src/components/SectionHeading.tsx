import { Group, Text, UnstyledButton } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * A section rule.
 *
 * The heading sits closer to the cards it labels than to the section
 * above it, so it groups downward rather than floating between the two.
 * The asymmetry is what does that, and it is smaller than it looks from
 * the props: this renders inside a `Stack gap="md"`, so the 16px `mt`
 * lands on top of the Stack's own 16px for 32px of real space above,
 * against the 10px `mb` below.
 *
 * `mt` was `xl`, which made that 48px above and read as a gap in the
 * page rather than a division within it.
 *
 * Passing `collapsed` turns the whole rule into the section's disclosure
 * control. The heading already carries the count, so a collapsed section
 * still reports how many streamers it holds -- no separate "12 hidden"
 * label, and no risk of an empty section reading as an empty roster.
 *
 * `action` sits at the rule's right end, beside the toggle rather than
 * inside it: a button nested in the disclosure button is invalid markup,
 * and a click on it would also collapse the section.
 */
export function SectionHeading({ children, testId, collapsed, onToggle, action }: {
  children: string;
  testId?: string;
  collapsed?: boolean;
  onToggle?: () => void;
  action?: ReactNode;
}) {
  const label = (
    <>
      <Text
        size="xs" fw={700} c="dimmed"
        style={{ letterSpacing: "0.1em", whiteSpace: "nowrap" }}
      >
        {children}
      </Text>
      <div style={{ flex: 1, height: 1, background: "var(--tw-border)" }} />
    </>
  );

  if (!onToggle) {
    return (
      <Group gap="sm" wrap="nowrap" mt="md" mb="xs" data-testid={testId}>
        {label}
        {action}
      </Group>
    );
  }

  const toggle = (
    <UnstyledButton
      onClick={onToggle}
      data-testid={testId}
      aria-expanded={!collapsed}
      mt={action ? undefined : "md"} mb={action ? undefined : "xs"}
      style={{ display: "block", width: "100%", flex: action ? 1 : undefined }}
    >
      <Group gap="sm" wrap="nowrap">
        {/* A caret rather than a chevron icon: the app pulls in no icon
            set, and a rotated glyph costs nothing to ship. */}
        <Text
          size="xs" c="dimmed" aria-hidden
          style={{
            display: "inline-block",
            transition: "transform 150ms ease",
            transform: collapsed ? "rotate(-90deg)" : "none",
          }}
        >
          ▾
        </Text>
        {label}
      </Group>
    </UnstyledButton>
  );
  if (!action) return toggle;
  return (
    <Group gap="sm" wrap="nowrap" mt="md" mb="xs">
      {toggle}
      {action}
    </Group>
  );
}
