"""Pins the shape of the miner's point-gain log line.

The dashboard card shows how many points the last event earned. That
figure is not sent as a field: the miner's hook contract passes only
`(record.msg, record.event)` (see `EventHook.validate_and_send`), so the
amount is parsed back out of the formatted message by
`apps/frontend/src/lib/parseActivity.ts`.

Parsing display text is a deliberate trade -- the alternative is patching
vendored upstream code to attach structured fields to the log record --
but it fails *silently*: a reworded upstream line yields no amount, the
card quietly drops back to a bare label, and every hand-written fixture on
the TypeScript side keeps passing. So the shape is pinned here, against
the real formatter, where a vendor bump breaks it loudly instead.

If this fails, upstream changed the gain line. Update the regexes in
parseActivity.ts to match, then update the captured strings here and the
`REAL` fixture in parseActivity.test.ts.
"""
import logging
import platform

from TwitchChannelPointsMiner.classes.Settings import Events
from TwitchChannelPointsMiner.logger import GlobalFormatter, LoggerSettings

from helpers.doorbell import _clean

# Mirrors python/run.py's LoggerSettings, minus the live hook. Every
# default that shapes the message matters: `less` False keeps the Streamer
# rendering through __repr__, and `emoji` (True off Windows) decides both
# the leading glyph and whether the arrow survives as U+2192.
SETTINGS_KWARGS = {"save": True, "console_level": 20}

# The console format run.py's settings select, from configure_loggers().
CONSOLE_FMT = "%(asctime)s - %(levelname)s - [%(funcName)s]: %(message)s"


def _format(msg, event_name, **overrides):
    """Runs a PubSub-shaped record through the real formatter.

    Returns what the doorbell hook would hand the backend: the formatter
    mutates `record.msg` in place and dispatches hooks from inside
    `format()`, so the hook sees the mutated string, not the original.
    """
    settings = LoggerSettings(**{**SETTINGS_KWARGS, **overrides})
    # configure_loggers() sets this from `console_username`, which run.py
    # leaves False -- so the prefix is empty rather than "[user] ".
    settings.username = ""
    record = logging.LogRecord("t", logging.INFO, "f", 1, msg, None, None)
    # Exactly what PubSub attaches to the gain line.
    record.emoji = ":rocket:"
    record.event = Events.get(event_name)
    GlobalFormatter(
        fmt=CONSOLE_FMT, settings=settings, datefmt="%d/%m/%y %H:%M:%S"
    ).format(record)
    return _clean(record.msg)


# The line PubSub.py builds: f"+{earned} → {streamer} - Reason: {reason_code}."
# with a Streamer interpolated through __repr__.
GAIN_LINE = (
    "+50 → Streamer(username=forsen, channel_id=1, channel_points=12.3k)"
    " - Reason: CLAIM."
)


def test_pubsub_still_builds_the_gain_line_this_way():
    """The source string, before formatting -- upstream's own f-string."""
    import inspect

    from TwitchChannelPointsMiner.classes import PubSub

    source = inspect.getsource(PubSub)
    assert 'f"+{earned} → {streamer} - Reason: {reason_code}."' in source, (
        "PubSub no longer builds the gain line as "
        "'+{earned} → {streamer} - Reason: {reason_code}.'"
    )
    assert 'Events.get(f"GAIN_FOR_{reason_code}")' in source, (
        "PubSub no longer derives the event name as GAIN_FOR_{reason_code}, "
        "so parseActivity's type/reason cross-check is invalid"
    )


def test_gain_message_keeps_the_parts_the_card_reads():
    """The amount and the reason survive formatting and the doorbell scrub."""
    message = _format(GAIN_LINE, "GAIN_FOR_CLAIM")

    # The exact figure, which is what the card renders. Not anchored to the
    # start: the formatter prepends an emoji (see below).
    assert "+50" in message
    # The trailing reason, which parseActivity cross-checks against the
    # event type before trusting the amount.
    assert message.rstrip().endswith("- Reason: CLAIM.")


def test_gain_message_carries_the_emoji_prefix_the_parser_reads_past():
    """The regression that motivated this file.

    `emoji` defaults to True off Windows, so GlobalFormatter prepends the
    record's emoji. The glyph is printable, so the doorbell's control
    -character scrub keeps it -- and an amount regex anchored with ^\\+
    matches nothing, while un-prefixed unit-test fixtures keep passing.
    """
    if platform.system() == "Windows":
        return  # emoji defaults off; the arrow case below covers that path

    message = _format(GAIN_LINE, "GAIN_FOR_CLAIM")
    assert not message.startswith("+50"), (
        "the gain line no longer carries a prefix -- parseActivity's GAIN "
        "regex is deliberately unanchored to read past it"
    )
    assert "🚀" in message
    # The arrow survives as U+2192 while emoji are on.
    assert "→" in message


def test_arrow_becomes_ascii_when_emoji_are_disabled():
    """Windows, or any deployment turning emoji off, sends "-->" instead.

    parseActivity accepts it; this pins that the rewrite still happens, so
    the ASCII branch is not dead code guarding a case upstream dropped.
    """
    message = _format(GAIN_LINE, "GAIN_FOR_CLAIM", emoji=False)
    assert "-->" in message
    assert "→" not in message


def test_balance_in_the_line_stays_millified():
    """It is lossy display text, which is why the card never reads it.

    If upstream ever renders an exact balance here it would be tempting to
    parse -- this asserts the premise of that rule still holds.
    """
    message = _format(GAIN_LINE, "GAIN_FOR_CLAIM")
    assert "channel_points=12.3k" in message


def test_doorbell_scrub_preserves_the_whole_line():
    """_clean must not truncate or mangle a real gain line."""
    message = _format(GAIN_LINE, "GAIN_FOR_CLAIM")
    assert len(message) < 500
    assert "\n" not in message
