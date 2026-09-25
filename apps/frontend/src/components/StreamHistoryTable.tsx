import { Badge, Stack, Table, Text } from "@mantine/core";
import { sessionRows, type DetailSession } from "../lib/sessionRows.js";
import { formatWorkedMinutes } from "../lib/formatWorked.js";
import { formatClock, formatDay } from "../lib/formatClock.js";

const nf = new Intl.NumberFormat("en-US");

/** How many streams the table shows before it stops. Enough to see a
 *  pattern; short enough not to turn the dialog into a scroll. */
const LIMIT = 20;

/** Coverage below this is worth pointing at: most of the stream was missed. */
export const LOW_COVERAGE = 0.5;

/**
 * One row per stream: how long it ran, how much of it we mined, what it
 * earned.
 *
 * This is the table that answers "is this channel worth keeping", which
 * no chart does -- a balance line says points arrived, not whether the
 * streams producing them are ones we are actually present for.
 */
export function StreamHistoryTable({ sessions }: { sessions: DetailSession[] }) {
  const rows = sessionRows(sessions, Date.now()).slice(0, LIMIT);

  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="streams-empty">
        No streams recorded for this channel yet.
      </Text>
    );
  }

  return (
    <Stack gap="xs">
      <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
        STREAMS
      </Text>
      <Table.ScrollContainer minWidth={420}>
        <Table highlightOnHover verticalSpacing="xs" fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Length</Table.Th>
              <Table.Th>Mined</Table.Th>
              <Table.Th ta="right">Earned</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.streamId} data-testid="stream-row">
                <Table.Td>
                  {formatDay(row.start)}{" "}
                  {/* Channels that go live more than once a day need the
                      time to tell their rows apart. A live stream has no
                      end yet, so its range stays open. The range wraps
                      below the date as a unit when the cell is narrow. */}
                  <Text
                    span size="xs" c="dimmed" ml={4}
                    style={{ whiteSpace: "nowrap" }}
                    data-testid="stream-time"
                  >
                    {formatClock(row.start)}–{row.end === null ? "" : formatClock(row.end)}
                  </Text>
                  {row.live && (
                    <Badge color="twitch" variant="light" size="xs" ml={6}>live</Badge>
                  )}
                </Table.Td>
                <Table.Td>{formatWorkedMinutes(row.length)}</Table.Td>
                <Table.Td>
                  {formatWorkedMinutes(row.mined)}
                  {row.coverage !== null && row.coverage < LOW_COVERAGE && (
                    // The one actionable signal in the dialog: the stream
                    // ran and we were not there for most of it.
                    <Badge
                      color="yellow" variant="light" size="xs" ml={6}
                      data-testid="low-coverage"
                    >
                      {Math.round(row.coverage * 100)}%
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td ta="right" data-testid="stream-earned">
                  {row.earned === null
                    ? "—"
                    : `${row.earned > 0 ? "+" : ""}${nf.format(row.earned)}`}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {sessions.length > LIMIT && (
        <Text size="xs" c="dimmed">
          Showing {LIMIT} of {sessions.length} recorded streams.
        </Text>
      )}
    </Stack>
  );
}
