"""Session caps and shared process protection, without live requests or identity."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from services.ai_fair_use import FairUseLimiter


NOW = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)


def test_five_attempt_cap_survives_time_changes_and_is_not_a_daily_student_limit():
    limiter, session = FairUseLimiter(), {}
    for index in range(5):
        assert limiter.reserve(session, NOW + timedelta(minutes=index)) is None
    denial = limiter.reserve(session, NOW + timedelta(days=1))
    assert "five generation attempts" in denial.message
    assert denial.retry_at is None  # No invented daily/session reset timestamp.
    assert session["attempts"] == 5
    assert limiter.reserve({}, NOW + timedelta(days=1)) is None  # New sessions can bypass the session cap.


def test_session_cooldown_cannot_be_bypassed_by_repeated_reservations():
    limiter, session = FairUseLimiter(), {}
    assert limiter.reserve(session, NOW) is None
    for seconds in (0, 1, 59):
        denial = limiter.reserve(session, NOW + timedelta(seconds=seconds))
        assert "Session cooldown" in denial.message
        assert denial.retry_at == NOW + timedelta(seconds=60)
    assert session["attempts"] == 1
    assert limiter.reserve(session, NOW + timedelta(seconds=60)) is None
    assert session["attempts"] == 2


def test_many_sessions_share_process_rate_budget_atomically():
    limiter = FairUseLimiter()
    with ThreadPoolExecutor(max_workers=16) as executor:
        outcomes = list(executor.map(lambda _: limiter.reserve({}, NOW), range(40)))
    assert sum(outcome is None for outcome in outcomes) == 10
    assert limiter.process_actions(NOW) == 10
    assert limiter.reserve({}, NOW + timedelta(seconds=59)) is not None
    assert limiter.reserve({}, NOW + timedelta(seconds=60)) is None


def test_process_daily_budget_and_utc_reset_do_not_reset_session_counters():
    limiter = FairUseLimiter()
    # Fresh sessions bypass session caps, but not the shared process cap.
    for index in range(500):
        assert limiter.reserve({}, NOW + timedelta(seconds=index * 7)) is None
    end = NOW + timedelta(hours=2)
    denial = limiter.reserve({}, end)
    assert "500" in denial.message
    assert denial.retry_at == NOW.replace(hour=0) + timedelta(days=1)
    assert limiter.process_actions(end) == 500
    assert limiter.reserve({}, denial.retry_at) is None
    assert limiter.process_actions(denial.retry_at) == 1


def test_provider_holds_survive_day_changes_until_their_actual_deadline():
    limiter = FairUseLimiter()
    until = NOW + timedelta(days=2)
    limiter.hold_provider("Groq", until)
    limiter.hold_provider("Groq", NOW + timedelta(minutes=1))
    assert limiter.provider_holds(NOW)["Groq"] == until
    limiter.reserve({}, NOW + timedelta(days=1))
    assert limiter.provider_holds(NOW + timedelta(days=1))["Groq"] == until
    snapshot = limiter.provider_holds(NOW)
    snapshot.clear()
    assert limiter.provider_holds(NOW)["Groq"] == until
    assert limiter.provider_holds(until) == {}
