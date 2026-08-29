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


def test_payload_carries_only_event_name_and_timestamp():
    """No message text: Streamer.__repr__ millifies balances, so the
    message is lossy and must never become a data source."""
    seen = []
    hook = DoorbellHook("http://unused", "tok", post=seen.append)
    hook.send("+50 -> Streamer(channel_points=12.3k)", Events.GAIN_FOR_CLAIM)
    hook.flush(timeout=2)
    hook.stop()
    assert len(seen) == 1
    assert set(seen[0]) == {"event", "ts"}
    assert seen[0]["event"] == "GAIN_FOR_CLAIM"


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
