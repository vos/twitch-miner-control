"""Doorbell: tells the backend that something happened, and how the miner
said it.

Upstream hooks are dispatched synchronously from inside
LoggerFormatter.format(), so send() must return immediately.

The payload carries the formatted message purely so the UI can show the
miner's own wording -- which, unlike the bare Events name, includes the
streamer. It is display text and nothing else: messages render balances
through millify() ("12.3k"), so they remain lossy and must never be parsed
back into numbers. Point history comes from the state pipeline instead.
"""
import logging
import queue
import re
import threading
import time

import requests

from TwitchChannelPointsMiner.classes.EventHook import EventHook

logger = logging.getLogger(__name__)

# Longest message kept. Bet recaps are the wordiest events and sit far
# under this; the cap exists so a pathological message cannot bloat the
# events table or the feed.
MAX_MESSAGE = 500

# Colorama wraps messages in ANSI escapes when the palette is enabled, and
# recaps embed newlines. Feed rows are single-line, so both collapse away
# rather than reaching storage.
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")


def _clean(message) -> str:
    """Reduces a formatted log message to one bounded, printable line."""
    text = _ANSI.sub("", str(message))
    text = _CONTROL.sub(" ", text).strip()
    return text[:MAX_MESSAGE]


class DoorbellHook(EventHook):
    def __init__(self, url, token, queue_size=256, post=None):
        self.url = url
        self.token = token
        self.dropped = 0
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

    def validate_record(self, record) -> bool:
        return hasattr(record, "event")

    def send(self, message: str, event) -> None:
        try:
            self._queue.put_nowait(
                {
                    "event": str(event),
                    "ts": time.time(),
                    "message": _clean(message),
                }
            )
        except queue.Full:
            self.dropped += 1

    def flush(self, timeout=5):
        deadline = time.monotonic() + timeout
        while not self._queue.empty() and time.monotonic() < deadline:
            time.sleep(0.01)

    def stop(self):
        if self._stopping.is_set():
            return
        self._stopping.set()
        self._queue.put(None)
        self._worker.join(timeout=2)
