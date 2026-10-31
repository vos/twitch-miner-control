"""Doorbell: tells the backend that something happened, and what.

An EventHandler on the miner's EventManager. Upstream hands every handler
the typed Event itself, so the facts the backend needs -- which streamer,
how many points, the balance, a drop's progress -- cross the wire as fields
rather than being recovered from display text. The message still rides along, worded by the miner's
own translations, purely so the feed can show it.

The EventManager runs handlers on its task runner's threads, so handle()
does not block the miner itself. It still only enqueues: one worker posts
in order, and a slow or absent backend costs dropped rings rather than a
runner slot held for the whole HTTP timeout.
"""
import logging
import queue
import re
import threading
import time

import requests

from TwitchChannelPointsMiner.classes.events.Event import (
    ChangingWatchSlots,
    DropEvent,
    Error,
    Event,
    GainPoints,
    PointsSpent,
    PredictionFailed,
)
from TwitchChannelPointsMiner.classes.events.Events import Events
from TwitchChannelPointsMiner.classes.events.Handler import EventHandler
from TwitchChannelPointsMiner.classes.events.Transformer import EventTransformer
from TwitchChannelPointsMiner.classes.events.handlers.Factory import EventHandlerFactory
from TwitchChannelPointsMiner.classes.events.transformers.Strings import (
    EmojiTransformer,
    MultiTransformer,
    StaticStringTransformer,
    TranslatorTransformer,
)
from TwitchChannelPointsMiner.utils.Utils import normalise_username

logger = logging.getLogger(__name__)

# Longest message kept. Prediction recaps are the wordiest events and sit
# far under this; the cap exists so a pathological message cannot bloat
# the events table or the feed.
MAX_MESSAGE = 500

# Messages can embed newlines, and a coloured transformer would add ANSI
# escapes. Feed rows are single-line, so both collapse away rather than
# reaching storage.
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")

# Every event, less the ones that repeat every few seconds or only
# announce the claim event that follows them. Most rings are a feed row,
# so these would be noise.
DOORBELL_EVENTS = Events.all() & ~(
    Events.STREAM_UP
    | Events.STREAM_DOWN
    | Events.STREAM_VIEW_COUNT
    | Events.BONUS_POINTS_AVAILABLE
    | Events.MOMENT_CLAIM_AVAILABLE
    | Events.DROP_CLAIM_AVAILABLE
    | Events.PREDICTION_EVENT_UPDATE
)


def _clean(message) -> str:
    """Reduces a formatted message to one bounded, printable line."""
    text = _ANSI.sub("", str(message))
    text = _CONTROL.sub(" ", text).strip()
    return text[:MAX_MESSAGE]


def _login(streamer) -> str | None:
    return normalise_username(streamer.username) if streamer is not None else None


def _drop(drop) -> dict:
    """A drop's figures, for the badge. Upstream joins the benefit names."""
    return {
        "id": drop.id,
        "name": drop.name,
        # Twitch keeps counting past the requirement.
        "minutes": min(drop.current_minutes_watched, drop.minutes_required),
        "required": drop.minutes_required,
        "benefits": [b for b in drop.benefit.split(", ") if b],
        "endsAt": int(drop.end_at.timestamp() * 1000),
    }


class DoorbellHandler(EventHandler):
    def __init__(
        self,
        url: str,
        token: str,
        transformer: EventTransformer[str],
        events: Events = DOORBELL_EVENTS,
        queue_size: int = 256,
        post=None,
    ):
        self.url = url
        self.token = token
        self.transformer = transformer
        self.events = events
        self.dropped = 0
        # The channels holding the miner's watch slots. The event carries
        # only what changed; the full set is sent so a missed ring is
        # corrected by the next one instead of compounding.
        self._watching: set[str] = set()
        self._watching_lock = threading.Lock()
        self._queue = queue.Queue(maxsize=queue_size)
        self._post = post if post is not None else self._http_post
        self._stopping = threading.Event()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def _http_post(self, payload):
        requests.post(
            self.url,
            json=payload,
            headers={"X-Doorbell-Token": self.token},
            timeout=5,
        )

    def _run(self):
        while True:
            item = self._queue.get()
            try:
                if item is None:
                    return
                self._post(item)
            except Exception:
                logger.debug("doorbell delivery failed", exc_info=True)
            finally:
                self._queue.task_done()

    def _message(self, event: Event) -> str | None:
        # The translation is display text; a template that cannot render
        # this event (upstream raises for a gift sub it cannot find) must
        # not cost the ring, which is what drives the refresh.
        try:
            return _clean(self.transformer.transform(event)) or None
        except Exception:
            logger.debug("doorbell could not render %s", event.type, exc_info=True)
            return None

    def handles(self) -> Events:
        return self.events

    def handle(self, event: Event) -> None:
        payload = {
            "event": event.type.name,
            "ts": event.timestamp.timestamp(),
            "message": self._message(event),
            "streamer": _login(getattr(event, "streamer", None)),
            "earned": event.amount if isinstance(event, GainPoints) else None,
            "balance": (
                event.balance if isinstance(event, (GainPoints, PointsSpent)) else None
            ),
        }
        if isinstance(event, DropEvent):
            payload["drop"] = _drop(event.drop)
        if isinstance(event, PredictionFailed):
            payload["errorCode"] = event.error_code
        if isinstance(event, Error):
            payload["context"] = event.context
        if isinstance(event, ChangingWatchSlots):
            with self._watching_lock:
                self._watching -= {_login(s) for s in event.dropping}
                self._watching |= {_login(s) for s in event.adding}
                payload["watching"] = sorted(self._watching)
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            self.dropped += 1

    def flush(self, timeout=5):
        deadline = time.monotonic() + timeout
        while self._queue.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.01)

    def shutdown(self):
        if self._stopping.is_set():
            return
        self._stopping.set()
        self._queue.put(None)
        self._worker.join(timeout=2)


def message_transformer(logger_settings, account_name: str) -> EventTransformer[str]:
    """The miner's own wording for an event, emoji first when enabled.

    The console's line minus its timestamp: the backend dates each row
    itself, and the feed renders the time in its own column.
    """
    parts: list[EventTransformer[str]] = []
    if logger_settings.emoji:
        parts += [EmojiTransformer(), StaticStringTransformer("  ")]
    parts.append(
        TranslatorTransformer(
            translator=logger_settings.translator, account_username=account_name
        )
    )
    return MultiTransformer(*parts)


def doorbell(url: str, token: str, **kwargs) -> EventHandlerFactory:
    """A handler factory, in the shape upstream's `handlers=` list takes."""

    def factory(logger_settings, background_tasks, default_transformer, account_name):
        return DoorbellHandler(
            url, token, message_transformer(logger_settings, account_name), **kwargs
        )

    return factory
