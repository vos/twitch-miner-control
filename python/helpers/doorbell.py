"""Doorbell: tells the backend that something happened, never what.

Upstream hooks are dispatched synchronously from inside
LoggerFormatter.format(), so send() must return immediately. The payload
deliberately carries no message text: log messages render balances through
millify() and are lossy.
"""
import logging
import queue
import threading
import time

import requests

from TwitchChannelPointsMiner.classes.EventHook import EventHook

logger = logging.getLogger(__name__)


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
            self._queue.put_nowait({"event": str(event), "ts": time.time()})
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
