"""Trustworthy quota observations; session counters are never shared balances.

References checked 2026-10-27:
https://developers.cloudflare.com/workers-ai/platform/pricing/
https://console.groq.com/docs/rate-limits
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import math
import re


UTC = timezone.utc
MALAYSIA = timezone(timedelta(hours=8), "MYT")
CLOUDFLARE_DAILY_NEURONS = 10_000


def utc_now() -> datetime:
    return datetime.now(UTC)


def next_cloudflare_reset(now: datetime) -> datetime:
    """Next 00:00 UTC, including when called exactly at midnight."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("Use a timezone-aware datetime.")
    now = now.astimezone(UTC)
    return now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)


def parse_duration(value: object) -> timedelta | None:
    """Parse documented Groq durations such as 2m59.56s; never guess units."""
    if not isinstance(value, str):
        return None
    matches = re.findall(r"(\d+(?:\.\d+)?)(ms|d|h|m|s)", value)
    if not matches or "".join(number + unit for number, unit in matches) != value:
        return None
    seconds = sum(
        float(number) * {"ms": .001, "s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
        for number, unit in matches
    )
    if not math.isfinite(seconds) or seconds > 366 * 86400:
        return None
    return timedelta(seconds=seconds)


def retry_after(value: object, now: datetime) -> datetime | None:
    """Honor seconds or an HTTP-date without sleeping or retrying automatically."""
    if not isinstance(value, str):
        return None
    try:
        seconds = float(value)
        if not math.isfinite(seconds) or not 0 <= seconds <= 366 * 86400:
            return None
        return now + timedelta(seconds=seconds)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
            return parsed.astimezone(UTC) if parsed.tzinfo else None
        except (TypeError, ValueError, OverflowError):
            return None


@dataclass(frozen=True)
class UsageObservation:
    provider: str
    checked_at: datetime
    daily_request_limit: int | None = None
    daily_requests_remaining: int | None = None
    requests_reset_at: datetime | None = None
    minute_tokens_remaining: int | None = None
    tokens_reset_at: datetime | None = None
    retry_at: datetime | None = None

    @property
    def balance_label(self) -> str:
        if self.provider == "Groq" and self.daily_requests_remaining is not None:
            return "Last checked (provider-reported, not a live balance)"
        return "Remaining shared usage unavailable"


def observe_usage(provider: str, headers: dict, now: datetime) -> UsageObservation:
    """Groq request headers refer to daily requests; token headers to minute tokens.

    Cloudflare's model schema documents request usage, not the remaining
    account-wide Neuron balance. No token-to-Neuron or remaining-balance estimate
    is made: https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/
    """
    headers = {key.lower(): value for key, value in headers.items()}

    def integer(name):
        value = headers.get(name)
        return int(value) if isinstance(value, str) and re.fullmatch(r"[0-9]{1,12}", value) else None

    def reset(name):
        duration = parse_duration(headers.get(name))
        return now + duration if duration is not None else None

    if provider != "Groq":
        return UsageObservation(provider, now, retry_at=retry_after(headers.get("retry-after"), now))
    return UsageObservation(
        provider, now,
        daily_request_limit=integer("x-ratelimit-limit-requests"),
        daily_requests_remaining=integer("x-ratelimit-remaining-requests"),
        requests_reset_at=reset("x-ratelimit-reset-requests"),
        minute_tokens_remaining=integer("x-ratelimit-remaining-tokens"),
        tokens_reset_at=reset("x-ratelimit-reset-tokens"),
        retry_at=retry_after(headers.get("retry-after"), now),
    )
