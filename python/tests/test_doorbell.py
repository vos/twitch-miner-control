import datetime
import threading
import time
from types import SimpleNamespace

from TwitchChannelPointsMiner.classes.Settings import Settings
from TwitchChannelPointsMiner.classes.Translator import Translator
from TwitchChannelPointsMiner.classes.entities.Raid import Raid
from TwitchChannelPointsMiner.classes.entities.Streamer import Streamer
from TwitchChannelPointsMiner.classes.entities.Drop import Drop
from TwitchChannelPointsMiner.classes.events.Event import (
    ChangingWatchSlots,
    DropClaim,
    DropClaimAvailable,
    DropProgress,
    Error,
    GainForClaim,
    GiftSubReceived,
    JoinRaid,
    PointsSpent,
    PredictionFailed,
    Shutdown,
    StreamerOnline,
    StreamViewCount,
)
from TwitchChannelPointsMiner.classes.events.Events import Events
from TwitchChannelPointsMiner.classes.events.Transformer import EventTransformer
from TwitchChannelPointsMiner.logger import LoggerSettings

from helpers.doorbell import (
    DOORBELL_EVENTS,
    DoorbellHandler,
    doorbell,
    message_transformer,
)
from helpers.vendor import locales_dir


class Fixed(EventTransformer[str]):
    def __init__(self, text="anything"):
        self.text = text

    def transform(self, event):
        return self.text


def _streamer(login="forsen", channel_id="1"):
    streamer = Streamer(login)
    streamer.channel_id = channel_id
    streamer.channel_points = 12345
    return streamer


def _handler(seen, transformer=None, **kwargs):
    return DoorbellHandler(
        "http://unused", "tok", transformer or Fixed(), post=seen.append, **kwargs
    )


def _send(handler, *events):
    for event in events:
        handler.handle(event)
    handler.flush(timeout=2)
    handler.shutdown()


def test_handle_does_not_block_when_transport_is_slow():
    """Handlers run on the EventManager's runner slots. A slow POST must
    hold neither one of those nor the miner."""
    release = threading.Event()
    handler = DoorbellHandler(
        "http://unused", "tok", Fixed(), post=lambda p: release.wait(timeout=5)
    )
    started = time.monotonic()
    for _ in range(10):
        handler.handle(StreamerOnline(streamer=_streamer()))
    elapsed = time.monotonic() - started
    release.set()
    handler.shutdown()
    assert elapsed < 0.1


def test_handle_drops_rather_than_blocks_when_queue_is_full():
    release = threading.Event()
    handler = DoorbellHandler(
        "http://unused", "tok", Fixed(), queue_size=2,
        post=lambda p: release.wait(timeout=5),
    )
    for _ in range(50):
        handler.handle(StreamerOnline(streamer=_streamer()))
    release.set()
    handler.shutdown()
    assert handler.dropped > 0


def _drop(minutes=20, required=60, benefits=("Sharky",)):
    end = datetime.datetime(2026, 11, 15, 12, tzinfo=datetime.timezone.utc)
    return Drop(
        _id="d1", name="Charm", benefits=list(benefits), minutes_required=required,
        subs_required=0, end_at=end, start_at=end, current_minutes_watched=minutes,
    )


def test_gain_carries_the_exact_balance():
    seen = []
    _send(_handler(seen), GainForClaim(streamer=_streamer(), amount=50, balance=1234567))
    assert seen[0]["balance"] == 1234567


def test_spending_points_carries_the_exact_balance():
    seen = []
    _send(_handler(seen), PointsSpent(streamer=_streamer(), amount=50, balance=900))
    assert seen[0]["balance"] == 900
    assert seen[0]["earned"] is None


def test_drop_progress_carries_the_drop_as_fields():
    """The badge moves on these: the message is display text, and the
    streamer and minutes in it must not be read back out of it."""
    seen = []
    _send(_handler(seen), DropProgress(streamer=_streamer(), drop=_drop(), progress=33))
    assert seen[0]["streamer"] == "forsen"
    assert seen[0]["drop"] == {
        "id": "d1", "name": "Charm", "minutes": 20, "required": 60,
        "benefits": ["Sharky"], "endsAt": 1794744000000,
    }


def test_drop_minutes_are_clamped_to_what_the_drop_needs():
    seen = []
    _send(_handler(seen), DropProgress(streamer=_streamer(), drop=_drop(71), progress=100))
    assert seen[0]["drop"]["minutes"] == 60


def test_a_claim_attempt_names_the_drop_it_was_for():
    seen = []
    _send(_handler(seen), DropClaim(streamer=None, drop=_drop()))
    assert seen[0]["drop"]["id"] == "d1"


def test_an_error_says_which_part_of_the_miner_reported_it():
    seen = []
    _send(_handler(seen), Error(context="Drops Claimer", message="boom", error=None))
    assert seen[0]["context"] == "Drops Claimer"


def test_a_failed_prediction_carries_twitchs_error_code():
    seen = []
    _send(_handler(seen), PredictionFailed(
        streamer=_streamer(), prediction_event=SimpleNamespace(), error_code="MUST_ACCEPT_TOS",
    ))
    assert seen[0]["errorCode"] == "MUST_ACCEPT_TOS"


def test_gain_carries_streamer_and_exact_amount_as_fields():
    """The point of moving to typed events: nothing downstream has to
    recover these from the wording, which millifies the balance."""
    seen = []
    _send(_handler(seen), GainForClaim(streamer=_streamer("ForSen"), amount=50, balance=12345))
    assert seen[0]["event"] == "GAIN_FOR_CLAIM"
    assert seen[0]["streamer"] == "forsen"
    assert seen[0]["earned"] == 50
    assert "watching" not in seen[0]
    assert isinstance(seen[0]["ts"], float)


def test_non_gain_events_carry_no_amount():
    seen = []
    _send(_handler(seen), StreamerOnline(streamer=_streamer()))
    assert seen[0]["earned"] is None
    assert seen[0]["streamer"] == "forsen"


def test_raid_is_attributed_to_the_raiding_channel_only():
    """A raid line names two channels, which made text matching give up.
    The event knows which one it is about."""
    seen = []
    raid = Raid(raid_id="r", target_login="xqc")
    _send(_handler(seen), JoinRaid(streamer=_streamer(), raid=raid, target_username="xqc"))
    assert seen[0]["streamer"] == "forsen"


def test_events_without_a_streamer_send_null():
    seen = []
    _send(_handler(seen), Shutdown(reason="CTRL-C"), DropClaimAvailable(streamer=None, drop="d"))
    assert [p["streamer"] for p in seen] == [None, None]


def test_watch_slots_send_the_full_set_not_the_delta():
    """A missed ring must not leave the backend's view wrong for good."""
    seen = []
    a, b, c = _streamer("a", "1"), _streamer("b", "2"), _streamer("c", "3")
    _send(
        _handler(seen),
        ChangingWatchSlots(adding=[a, b], dropping=[]),
        ChangingWatchSlots(adding=[c], dropping=[a]),
        ChangingWatchSlots(adding=[], dropping=[b, c]),
    )
    assert [p["watching"] for p in seen] == [["a", "b"], ["b", "c"], []]
    assert all(p["event"] == "CHANGING_WATCH_SLOTS" for p in seen)


def test_message_is_truncated_to_a_bounded_length():
    """Unbounded text would flow into the events table and then the DOM."""
    seen = []
    _send(_handler(seen, Fixed("x" * 5000)), StreamerOnline(streamer=_streamer()))
    assert len(seen[0]["message"]) == 500


def test_control_characters_are_collapsed_in_the_message():
    seen = []
    _send(
        _handler(seen, Fixed("\x1b[32m+50 forsen\x1b[0m\nsecond line")),
        StreamerOnline(streamer=_streamer()),
    )
    assert seen[0]["message"] == "+50 forsen second line"


def test_a_message_that_cannot_render_still_rings():
    """Upstream's gift sub template raises when it cannot find the sub;
    the ring is what drives the refresh, so it must survive that."""

    class Boom(EventTransformer[str]):
        def transform(self, event):
            raise ValueError("unable to find Gift Sub")

    seen = []
    _send(_handler(seen, Boom()), GiftSubReceived(streamer=_streamer()))
    assert seen[0]["event"] == "GIFT_SUB_RECEIVED"
    assert seen[0]["message"] is None


def test_transport_errors_do_not_escape():
    def boom(payload):
        raise RuntimeError("backend down")

    handler = DoorbellHandler("http://unused", "tok", Fixed(), post=boom)
    handler.handle(StreamerOnline(streamer=_streamer()))
    handler.flush(timeout=2)
    handler.shutdown()  # must not raise


def test_shutdown_is_idempotent():
    handler = _handler([])
    handler.shutdown()
    handler.shutdown()


def test_noisy_events_are_not_subscribed():
    """Each ring is a feed row and a state refresh."""
    for noisy in (Events.STREAM_VIEW_COUNT, Events.PREDICTION_EVENT_UPDATE,
                  Events.BONUS_POINTS_AVAILABLE, Events.STREAM_UP):
        assert noisy not in DOORBELL_EVENTS
    # The recap counts these, and the watch-slot set rides on the last.
    for wanted in (Events.BONUS_CLAIM, Events.JOIN_RAID, Events.DROP_CLAIM,
                   Events.GAIN_FOR_WATCH, Events.CHANGING_WATCH_SLOTS, Events.ERROR):
        assert wanted in DOORBELL_EVENTS


def test_message_uses_the_miners_own_translation():
    settings = LoggerSettings(save=False, emoji=False, translator=Translator(locales_dir()))
    Settings.logger = settings
    text = message_transformer(settings, "me").transform(
        GainForClaim(streamer=_streamer(), amount=50, balance=12345)
    )
    assert text.startswith("+50")
    assert "forsen" in text


def test_message_leads_with_the_emoji_when_enabled():
    settings = LoggerSettings(save=False, emoji=True, translator=Translator(locales_dir()))
    Settings.logger = settings
    text = message_transformer(settings, "me").transform(StreamerOnline(streamer=_streamer()))
    assert text.startswith("🥳")


def test_factory_has_the_shape_the_miner_calls():
    """TwitchChannelPointsMiner.__init__ calls an EventHandlerFactory with
    (logger_settings, background_tasks, default_transformer, username)."""
    from TwitchChannelPointsMiner.classes.events.handlers.Factory import EventHandlerFactory

    settings = LoggerSettings(save=False, translator=Translator(locales_dir()))
    factory = doorbell("http://unused", "tok", post=lambda p: None)
    assert isinstance(factory, EventHandlerFactory)
    handler = factory(settings, [], Fixed(), "me")
    try:
        assert isinstance(handler, DoorbellHandler)
        assert handler.handles() == DOORBELL_EVENTS
    finally:
        handler.shutdown()


def test_error_events_ring_with_their_context():
    seen = []
    settings = LoggerSettings(save=False, emoji=False, translator=Translator(locales_dir()))
    Settings.logger = settings
    _send(
        _handler(seen, message_transformer(settings, "me")),
        Error(context="Drops Claimer", message="boom", error=None),
    )
    assert seen[0]["event"] == "ERROR"
    assert "Drops Claimer" in seen[0]["message"]


def test_view_count_is_not_handled_by_the_manager():
    """QueueManager only submits an event whose type is in handles()."""
    handler = _handler([])
    try:
        assert StreamViewCount(streamer=_streamer(), view_count=3).type not in handler.handles()
    finally:
        handler.shutdown()
