"""Confirmed-write rate limiter (src/ratelimit.ts port)."""

import time


class RateLimiter:
    def __init__(self, limit_per_hour: int) -> None:
        self.limit_per_hour = limit_per_hour
        self._window = 0
        self._count = 0

    def try_consume(self, now: float | None = None) -> int | None:
        """Returns None when allowed, otherwise the seconds until the window resets."""
        now_ms = int((now if now is not None else time.time()) * 1000)
        win = now_ms // 3_600_000
        if win != self._window:
            self._window = win
            self._count = 0
        if self._count + 1 > self.limit_per_hour:
            return (self._window + 1) * 3600 - int(now_ms / 1000)
        self._count += 1
        return None

    @property
    def remaining(self) -> int:
        win = int(time.time() * 1000) // 3_600_000
        if win != self._window:
            return self.limit_per_hour
        return max(0, self.limit_per_hour - self._count)
