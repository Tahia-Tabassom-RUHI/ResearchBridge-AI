"""Quota parsing and timezone checks; no network or credentials required."""

from datetime import datetime, timedelta, timezone

import pytest

from services.ai_usage import (
    MALAYSIA, UsageObservation, next_cloudflare_reset, observe_usage,
    parse_duration, retry_after,
)


NOW = datetime(2026, 10, 27, 23, 30, tzinfo=timezone.utc)


@pytest.mark.parametrize("now", [NOW, NOW.astimezone(MALAYSIA)])
def test_cloudflare_reset_is_next_utc_midnight_and_eight_am_malaysia(now):
    reset = next_cloudflare_reset(now)
    assert reset == datetime(2026, 10, 28, tzinfo=timezone.utc)
    assert reset - now == timedelta(minutes=30)
    assert reset.astimezone(MALAYSIA).hour == 8


def test_exact_midnight_and_naive_datetime_handling():
    midnight = NOW.replace(hour=0, minute=0)
    assert next_cloudflare_reset(midnight) - midnight == timedelta(days=1)
    with pytest.raises(ValueError, match="timezone-aware"):
        next_cloudflare_reset(datetime(2026, 10, 27))


@pytest.mark.parametrize("value,seconds", [("2m59.56s", 179.56), ("1h2m3s", 3723), ("250ms", .25), ("0s", 0)])
def test_groq_documented_durations(value, seconds):
    assert parse_duration(value).total_seconds() == pytest.approx(seconds)


@pytest.mark.parametrize("value", [None, "", "123", "-2s", "NaNs", "3minutes", "1s garbage", "999999999999999d"])
def test_unknown_duration_units_are_not_guessed(value):
    assert parse_duration(value) is None


def test_groq_headers_are_observed_not_a_live_or_estimated_shared_balance():
    observation = observe_usage("Groq", {
        "X-RateLimit-Limit-Requests": "1000",
        "x-ratelimit-remaining-requests": "999",
        "x-ratelimit-reset-requests": "2m59.56s",
        "x-ratelimit-remaining-tokens": "7000",
        "x-ratelimit-reset-tokens": "7.66s",
        "Retry-After": "12",
    }, NOW)
    assert observation.daily_request_limit == 1000
    assert observation.daily_requests_remaining == 999
    assert observation.minute_tokens_remaining == 7000
    assert observation.requests_reset_at == NOW + timedelta(seconds=179.56)
    assert observation.tokens_reset_at == NOW + timedelta(seconds=7.66)
    assert observation.retry_at == NOW + timedelta(seconds=12)
    assert observation.checked_at == NOW
    assert observation.balance_label == "Last checked (provider-reported, not a live balance)"
    assert "estimated" not in observation.balance_label


@pytest.mark.parametrize("provider", ["Cloudflare", "Groq"])
def test_missing_headers_do_not_invent_balances(provider):
    observation = observe_usage(provider, {}, NOW)
    assert observation.daily_requests_remaining is None
    assert observation.requests_reset_at is None
    assert observation.balance_label == "Remaining shared usage unavailable"


def test_cloudflare_token_counts_are_not_neurons_or_remaining_shared_balance():
    observation = observe_usage("Cloudflare", {"x-ratelimit-remaining-requests": "9000"}, NOW)
    assert observation.daily_requests_remaining is None
    assert observation.balance_label == "Remaining shared usage unavailable"


def test_invalid_headers_and_zero_are_handled_safely():
    observation = observe_usage("Groq", {
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-remaining-tokens": "-4",
        "x-ratelimit-limit-requests": "not a number",
    }, NOW)
    assert observation.daily_requests_remaining == 0
    assert observation.minute_tokens_remaining is None
    assert observation.daily_request_limit is None


@pytest.mark.parametrize("value", [None, "", "-1", "nan", "inf", "invalid", "999999999999999"])
def test_invalid_retry_after(value):
    assert retry_after(value, NOW) is None


def test_retry_after_seconds_or_http_date():
    assert retry_after("120", NOW) == NOW + timedelta(minutes=2)
    assert retry_after("Wed, 28 Oct 2026 00:00:00 GMT", NOW) == next_cloudflare_reset(NOW)


@pytest.mark.parametrize("value", ["²", "9" * 5000])
def test_malformed_numeric_headers_cannot_crash_usage_parsing(value):
    observation = observe_usage("Groq", {"x-ratelimit-remaining-requests": value}, NOW)
    assert observation.daily_requests_remaining is None
    assert observation.balance_label == "Remaining shared usage unavailable"
