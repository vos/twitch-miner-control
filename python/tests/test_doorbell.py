import threading
import time

from TwitchChannelPointsMiner.classes.Settings import Events

from helpers.doorbell import DoorbellHook


def test_send_does_not_block_when_transport_is_slow():
    """The hook runs inside LoggerFormatter.format() on the miner's own
    threads. A slow POST must never stall the miner."""
    release = threading.Event()

    def slow_post(payload):
        release.wait(timeout=5)

    hook = DoorbellHook("http://unused", "tok", post=slow_post)
    started = time.monotonic()
    for _ in range(10):
        hook.send("anything", Events.STREAMER_ONLINE)
    elapsed = time.monotonic() - started
    release.set()
    hook.stop()
    assert elapsed < 0.1


def test_send_drops_rather_than_blocks_when_queue_is_full():
    release = threading.Event()
    hook = DoorbellHook(
        "http://unused", "tok", queue_size=2, post=lambda p: release.wait(timeout=5)
    )
    for _ in range(50):
        hook.send("anything", Events.STREAMER_ONLINE)
    release.set()
    hook.stop()
    assert hook.dropped > 0


def test_payload_carries_event_name_timestamp_and_message():
    """The message rides along for display only. Streamer.__repr__ still
    millifies balances, so it stays lossy and must never become a numeric
    data source -- point history comes from the state pipeline, not from
    here. It is carried because this is the only place the streamer's name
    and the miner's own phrasing survive."""
    seen = []
    hook = DoorbellHook("http://unused", "tok", post=seen.append)
    hook.send("+50 -> Streamer(channel_points=12.3k)", Events.GAIN_FOR_CLAIM)
    hook.flush(timeout=2)
    hook.stop()
    assert len(seen) == 1
    assert set(seen[0]) == {"event", "ts", "message"}
    assert seen[0]["event"] == "GAIN_FOR_CLAIM"
    assert seen[0]["message"] == "+50 -> Streamer(channel_points=12.3k)"


def test_message_is_truncated_to_a_bounded_length():
    """Unbounded text would flow into the events table and then the DOM."""
    seen = []
    hook = DoorbellHook("http://unused", "tok", post=seen.append)
    hook.send("x" * 5000, Events.STREAMER_ONLINE)
    hook.flush(timeout=2)
    hook.stop()
    assert len(seen[0]["message"]) == 500


def test_control_characters_are_collapsed_in_the_message():
    """With a colored palette the formatter wraps messages in ANSI escapes,
    and bet recaps embed newlines. Neither belongs in a one-line feed row."""
    seen = []
    hook = DoorbellHook("http://unused", "tok", post=seen.append)
    hook.send("\x1b[32m+50 forsen\x1b[0m\nsecond line", Events.GAIN_FOR_CLAIM)
    hook.flush(timeout=2)
    hook.stop()
    assert seen[0]["message"] == "+50 forsen second line"


def test_records_without_event_attribute_are_ignored():
    hook = DoorbellHook("http://unused", "tok", post=lambda p: None)
    assert hook.validate_record(object()) is False
    hook.stop()


def test_transport_errors_do_not_escape():
    def boom(payload):
        raise RuntimeError("backend down")

    hook = DoorbellHook("http://unused", "tok", post=boom)
    hook.send("anything", Events.STREAMER_ONLINE)
    hook.flush(timeout=2)
    hook.stop()  # must not raise
