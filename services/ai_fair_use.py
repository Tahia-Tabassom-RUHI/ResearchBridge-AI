"""Best-effort session and single-process protection, without identity or storage.

Only counters, request timestamps, and provider hold times are shared. No paper
content or generated responses are cached across students. Restarting this
process loses its state; replicas do not share it. This is NOT user/day enforcement.
"""

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from threading import Lock

from services.ai_usage import UTC, next_cloudflare_reset


SESSION_ATTEMPT_LIMIT = 5
SESSION_COOLDOWN_SECONDS = 60
PROCESS_DAILY_LIMIT = 500
PROCESS_MINUTE_LIMIT = 10


@dataclass(frozen=True)
class FairUseDenial:
    message: str
    retry_at: datetime | None = None


class FairUseLimiter:
    """Atomic reservations across sessions sharing this Python process."""

    def __init__(self):
        self._lock = Lock()
        self._day = None
        self._daily_actions = 0
        self._recent = deque()
        self._provider_holds = {}

    def _refresh(self, now):
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("Use a timezone-aware datetime.")
        day = now.astimezone(UTC).date()
        if self._day != day:
            self._day = day
            self._daily_actions = 0
        while self._recent and self._recent[0] <= now - timedelta(minutes=1):
            self._recent.popleft()

    def _denial(self, session, now):
        if session.get("attempts", 0) >= SESSION_ATTEMPT_LIMIT:
            return FairUseDenial(
                "This session has reached its five generation attempts. Failed "
                "requests count too. Manual reading remains available."
            )
        last = session.get("last_attempt_at")
        if last is not None and now < last + timedelta(seconds=SESSION_COOLDOWN_SECONDS):
            return FairUseDenial(
                "Session cooldown: wait 60 seconds between generation attempts.",
                last + timedelta(seconds=SESSION_COOLDOWN_SECONDS),
            )
        if self._daily_actions >= PROCESS_DAILY_LIMIT:
            return FairUseDenial(
                "This server process has reached its application budget of 500 "
                "generation attempts for this UTC day. This is not a provider balance.",
                next_cloudflare_reset(now),
            )
        if len(self._recent) >= PROCESS_MINUTE_LIMIT:
            return FairUseDenial(
                "This server process is busy: its application budget allows ten "
                "generation attempts per rolling minute.",
                self._recent[0] + timedelta(minutes=1),
            )
        return None

    def status(self, session: dict, now: datetime) -> FairUseDenial | None:
        with self._lock:
            self._refresh(now)
            return self._denial(session, now)

    def reserve(self, session: dict, now: datetime) -> FairUseDenial | None:
        """Count an action before network access, even if generation later fails.

        One reservation covers a primary request and its one allowed fallback.
        Neither failed requests nor resetting a paper refunds reservations.
        """
        with self._lock:
            self._refresh(now)
            denied = self._denial(session, now)
            if denied:
                return denied
            session["attempts"] = session.get("attempts", 0) + 1
            session["last_attempt_at"] = now
            self._daily_actions += 1
            self._recent.append(now)
            return None

    def process_actions(self, now: datetime) -> int:
        with self._lock:
            self._refresh(now)
            return self._daily_actions

    def hold_provider(self, provider: str, until: datetime) -> None:
        """Only record holds derived from actual provider responses."""
        with self._lock:
            previous = self._provider_holds.get(provider)
            if previous is None or until > previous:
                self._provider_holds[provider] = until

    def provider_holds(self, now: datetime) -> dict[str, datetime]:
        with self._lock:
            self._provider_holds = {
                name: until for name, until in self._provider_holds.items() if until > now
            }
            return self._provider_holds.copy()


_PROCESS_LIMITER = FairUseLimiter()


def get_fair_use_limiter() -> FairUseLimiter:
    return _PROCESS_LIMITER
