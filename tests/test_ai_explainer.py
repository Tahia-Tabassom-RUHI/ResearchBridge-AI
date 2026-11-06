"""Mock-only provider, grounding, quota/fallback, and HTTP transport tests."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import io
import json
from urllib.error import HTTPError, URLError
from unittest.mock import Mock

import pytest

from services import ai_explainer as ai
from services import ai_fair_use as fair


TITLE = "Synthetic reading fixture"
ABSTRACT = (
    "This is a synthetic reading fixture, not a research finding. It describes "
    "a classroom exercise about reading summaries and asks students to identify "
    "a problem, an approach, and information that a summary does not state."
)
NOW = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
CF = ai.ProviderConfig("Cloudflare", ai.CLOUDFLARE_MODEL, "test-token", "test-account", True)
GROQ = ai.ProviderConfig("Groq", ai.GROQ_MODEL, "test-groq", free_plan_confirmed=True)


def valid_pack():
    return {
        key: {"explanation": "The abstract describes a classroom exercise about reading summaries.",
              "supporting_excerpt": "a classroom exercise about reading summaries"}
        for key in ai.CARD_TITLES
    }


def response(provider="Cloudflare", pack=None, headers=None):
    completion = {"choices": [{"finish_reason": "stop", "message": {
        "content": json.dumps(pack if pack is not None else valid_pack()),
    }}], "usage": {"prompt_tokens": 400, "completion_tokens": 200}}
    body = {"success": True, "result": completion} if provider == "Cloudflare" else completion
    return ai.HTTPResponse(200, headers or {}, json.dumps(body).encode())


def error_response(code=3036, status=429, headers=None):
    return ai.HTTPResponse(status, headers or {}, json.dumps({
        "success": False, "errors": [{"code": code, "message": "Never expose token or upgrade text"}],
    }).encode())


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr(fair, "_PROCESS_LIMITER", fair.FairUseLimiter())
    monkeypatch.setattr(ai, "urlopen", Mock(side_effect=AssertionError("Live requests are forbidden in tests")))


@pytest.fixture
def transport(monkeypatch):
    mock = Mock(return_value=response())
    monkeypatch.setattr(ai, "_http_post", mock)
    return mock


@pytest.mark.parametrize("config", [CF, GROQ])
def test_four_cards_are_generated_in_one_bounded_request(config, transport):
    transport.return_value = response(config.name)
    result = ai.generate_explanations(TITLE, ABSTRACT, [config], now=NOW)
    assert result.pack == valid_pack()
    assert len(result.attempts) == 1
    assert result.attempts[0].kind == "success"
    assert result.attempts[0].request_sent
    transport.assert_called_once()
    url, token, payload = transport.call_args.args
    assert "https://" in url
    assert payload["max_tokens"] == ai.MAX_OUTPUT_TOKENS
    assert payload["stream"] is False
    assert payload["response_format"]["type"] == "json_schema"
    assert json.loads(payload["messages"][1]["content"]) == {"title": TITLE, "abstract": ABSTRACT}
    assert "Never invent" in payload["messages"][0]["content"]
    assert result.attempts[0].usage.balance_label == "Remaining shared usage unavailable"


def test_not_stated_cards_are_short_without_invented_explanations(transport):
    pack = valid_pack()
    pack["limitations"] = {"explanation": ai.NOT_STATED, "supporting_excerpt": None}
    transport.return_value = response(pack=pack)
    assert ai.generate_explanations(TITLE, ABSTRACT, [CF], now=NOW).pack == pack


@pytest.mark.parametrize("case", ["missing", "extra", "wrong_type", "empty", "too_long", "excerpt", "no_evidence", "numeric", "bad_excerpt_type"])
def test_shape_length_and_grounding_failures_are_not_saved(case, transport):
    pack = valid_pack()
    if case == "missing":
        del pack["method"]
    elif case == "extra":
        pack["extra"] = {}
    elif case == "wrong_type":
        pack["method"] = "text"
    elif case == "empty":
        pack["method"]["explanation"] = ""
    elif case == "too_long":
        pack["method"]["explanation"] = "word " * 91
    elif case == "excerpt":
        pack["method"]["supporting_excerpt"] = "an invented quotation"
    elif case == "no_evidence":
        pack["method"]["supporting_excerpt"] = None
    elif case == "numeric":
        pack["method"]["explanation"] = "The abstract reports 99% accuracy."
    else:
        pack["method"]["supporting_excerpt"] = ["not a string"]
    transport.return_value = response(pack=pack)
    result = ai.generate_explanations(TITLE, ABSTRACT, [CF, GROQ], now=NOW)
    assert result.pack is None
    assert result.attempts[0].kind == "malformed"
    transport.assert_called_once()  # Invalid model output never triggers fallback.


@pytest.mark.parametrize("body", [b"not json", b"[]", b"null", b'{"result":{}}', b'\xff'])
def test_invalid_envelopes_and_json_are_handled(body, transport):
    transport.return_value = ai.HTTPResponse(200, {}, body)
    result = ai.generate_explanations(TITLE, ABSTRACT, [CF], now=NOW)
    assert result.pack is None
    assert result.attempts[0].kind == "malformed"


def test_cloudflare_json_mode_object_response_is_supported(transport):
    transport.return_value = ai.HTTPResponse(200, {}, json.dumps({
        "success": True, "result": {"response": valid_pack()},
    }).encode())
    assert ai.generate_explanations(TITLE, ABSTRACT, [CF], now=NOW).pack == valid_pack()


@pytest.mark.parametrize("error,kind", [(TimeoutError(), "timeout"), (URLError(TimeoutError()), "timeout"), (URLError("offline"), "server")])
def test_transport_failures_do_not_retry_or_fallback(error, kind, transport):
    transport.side_effect = error
    result = ai.generate_explanations(TITLE, ABSTRACT, [CF, GROQ], now=NOW)
    assert result.attempts[0].kind == kind
    assert result.pack is None
    transport.assert_called_once()


@pytest.mark.parametrize("status,code,kind", [(500, 0, "server"), (401, 0, "credentials"), (403, 5035, "model"), (404, 3042, "model")])
def test_server_credentials_and_model_errors_are_sanitized(status, code, kind, transport):
    transport.return_value = error_response(code, status)
    result = ai.generate_explanations(TITLE, ABSTRACT, [CF, GROQ], now=NOW)
    assert result.attempts[0].kind == kind
    assert "upgrade" not in result.attempts[0].message
    assert "token" not in result.attempts[0].message
    transport.assert_called_once()


@pytest.mark.parametrize("code,kind", [(3036, "daily_limit"), (3040, "capacity"), (0, "rate_limit")])
def test_cloudflare_limit_classification_and_single_fallback(code, kind, transport):
    transport.side_effect = [error_response(code), response("Groq")]
    result = ai.generate_explanations(TITLE, ABSTRACT, [CF, GROQ], now=NOW)
    assert result.pack == valid_pack()
    assert [attempt.kind for attempt in result.attempts] == [kind, "success"]
    assert transport.call_count == 2
    reset = result.attempts[0].blocked_until
    assert reset == (NOW.replace(hour=0) + timedelta(days=1) if code == 3036 else NOW + timedelta(seconds=30))


def test_both_exhausted_providers_report_reset_and_retry_after(transport):
    transport.side_effect = [error_response(), ai.HTTPResponse(429, {
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "3h",
        "retry-after": "120",
    }, b'{}')]
    result = ai.generate_explanations(TITLE, ABSTRACT, [CF, GROQ], now=NOW)
    assert result.pack is None
    assert len(result.attempts) == 2
    assert result.attempts[1].blocked_until == NOW + timedelta(hours=3)
    assert result.attempts[1].usage.retry_at == NOW + timedelta(seconds=120)


def test_known_cooldown_skips_network_and_allows_backup(transport):
    transport.return_value = response("Groq")
    result = ai.generate_explanations(TITLE, ABSTRACT, [CF, GROQ], {"Cloudflare": NOW + timedelta(hours=1)}, NOW)
    assert [attempt.kind for attempt in result.attempts] == ["cooldown", "success"]
    assert not result.attempts[0].request_sent
    transport.assert_called_once()


def test_retry_after_blocks_repeat_requests_until_expired(transport):
    transport.return_value = ai.HTTPResponse(429, {"retry-after": "60"}, b'{}')
    result = ai.generate_explanations(TITLE, ABSTRACT, [GROQ], now=NOW)
    blocked = {"Groq": result.attempts[0].blocked_until}
    assert blocked["Groq"] == NOW + timedelta(minutes=1)
    again = ai.generate_explanations(TITLE, ABSTRACT, [GROQ], blocked, NOW + timedelta(seconds=10))
    assert again.attempts[0].kind == "cooldown"
    transport.assert_called_once()


@pytest.mark.parametrize("config", [
    ai.ProviderConfig("Cloudflare", ai.CLOUDFLARE_MODEL, "test", "account"),
    ai.ProviderConfig("Cloudflare", "@cf/zai-org/glm-5.3", "test", "account", True),
    ai.ProviderConfig("Groq", "unknown-model", "test", free_plan_confirmed=True),
])
def test_paid_unreviewed_or_unconfirmed_configuration_is_blocked(config, transport):
    result = ai.generate_explanations(TITLE, ABSTRACT, [config], now=NOW)
    assert result.attempts[0].kind == "configuration"
    assert not result.attempts[0].request_sent
    transport.assert_not_called()


def test_missing_credentials_and_direct_groq_configuration(transport):
    empty = ai.generate_explanations(TITLE, ABSTRACT, [], now=NOW)
    assert empty.pack is None and not empty.attempts
    transport.assert_not_called()
    transport.return_value = response("Groq")
    assert ai.generate_explanations(TITLE, ABSTRACT, [GROQ], now=NOW).pack == valid_pack()


def test_server_configuration_and_model_selection(monkeypatch):
    for key in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "GROQ_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    assert ai.load_provider_configs({}) == []
    configs = ai.load_provider_configs({
        "CLOUDFLARE_ACCOUNT_ID": "account", "CLOUDFLARE_API_TOKEN": "secret",
        "CLOUDFLARE_FREE_PLAN_CONFIRMED": True, "GROQ_API_KEY": "groq-secret",
        "GROQ_FREE_PLAN_CONFIRMED": True, "GROQ_AI_MODEL": "openai/gpt-oss-120b",
    })
    assert [config.name for config in configs] == ["Cloudflare", "Groq"]
    assert all(config.free_plan_confirmed for config in configs)
    assert configs[1].model == "openai/gpt-oss-120b"
    assert "secret" not in repr(configs)


def test_invalid_or_excessive_input_never_calls_provider(transport):
    for title, abstract in [("", ABSTRACT), (TITLE, "short"), (TITLE, ABSTRACT * 1000)]:
        with pytest.raises(ValueError):
            ai.generate_explanations(title, abstract, [CF])
    transport.assert_not_called()


def test_fingerprint_tracks_exact_title_and_abstract():
    first = ai.paper_fingerprint(TITLE, ABSTRACT)
    assert first != ai.paper_fingerprint(TITLE + "changed", ABSTRACT)
    assert first != ai.paper_fingerprint(TITLE, ABSTRACT + "changed")
    assert first == ai.paper_fingerprint(TITLE, ABSTRACT)


def test_http_adapter_bounds_timeout_and_reads_http_errors_without_retry(monkeypatch):
    error = HTTPError("https://api.groq.com/test", 429, "limited", {"retry-after": "30"}, io.BytesIO(b'{}'))
    opener = Mock(side_effect=error)
    monkeypatch.setattr(ai, "urlopen", opener)
    result = ai._http_post("https://api.groq.com/test", "test-token", {"stream": False})
    assert result.status == 429 and result.body == b'{}'
    assert result.headers["retry-after"] == "30"
    opener.assert_called_once()
    request = opener.call_args.args[0]
    assert request.get_header("Authorization") == "Bearer test-token"
    assert opener.call_args.kwargs["timeout"] == ai.TIMEOUT_SECONDS


def test_cloudflare_request_matches_documented_rest_json_schema_shape(transport):
    ai.generate_explanations(TITLE, ABSTRACT, [CF], now=NOW)
    url, _, payload = transport.call_args.args
    assert url == "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/qwen/qwen3-30b-a3b-fp8"
    assert payload["response_format"] == {"type": "json_schema", "json_schema": ai.PACK_SCHEMA}
    assert payload["response_format"]["json_schema"]["type"] == "object"
    assert set(payload["response_format"]["json_schema"]["properties"]) == set(ai.CARD_TITLES)
    assert "strict" not in payload["response_format"]["json_schema"]
    assert "schema" not in payload["response_format"]["json_schema"]
    assert payload["stream"] is False


@pytest.mark.parametrize("status,message", [
    (400, "Unsupported response_format for this model"),
    (400, "JSON Schema is not supported"),
    (422, "JSON Mode couldn't be met"),
    (200, "Invalid json_schema declaration"),
])
def test_cloudflare_format_errors_never_retry_or_fallback(status, message, transport):
    transport.return_value = ai.HTTPResponse(status, {}, json.dumps({
        "success": False, "errors": [{"code": 0, "message": message}],
    }).encode())
    result = ai.generate_explanations(TITLE, ABSTRACT, [CF, GROQ], now=NOW)
    assert result.pack is None
    assert result.attempts[0].kind == "response_format"
    assert "No retry or provider fallback" in result.attempts[0].message
    transport.assert_called_once()


def test_provider_daily_exhaustion_is_shared_across_sessions(transport):
    transport.return_value = error_response()
    limiter = fair.FairUseLimiter()
    first_session, second_session = {}, {}
    first = ai.generate_explanations(TITLE, ABSTRACT, [CF], now=NOW,
                                    session_usage=first_session, limiter=limiter)
    assert first.attempts[0].kind == "daily_limit"
    second = ai.generate_explanations(TITLE, ABSTRACT, [CF], now=NOW,
                                     session_usage=second_session, limiter=limiter)
    assert second.attempts[0].kind == "cooldown"
    assert not second.attempts[0].request_sent
    assert second_session == {}  # A held request consumes no generation action.
    transport.assert_called_once()
    transport.return_value = response()
    tomorrow = NOW + timedelta(days=1)
    assert ai.generate_explanations(TITLE, ABSTRACT, [CF], now=tomorrow,
                                   session_usage=second_session, limiter=limiter).pack
    assert transport.call_count == 2


def test_failed_generations_consume_five_attempt_session_budget(transport):
    transport.side_effect = TimeoutError()
    ledger = {}
    for index in range(5):
        result = ai.generate_explanations(TITLE, ABSTRACT, [CF], now=NOW + timedelta(minutes=index),
                                         session_usage=ledger)
        assert result.attempts[0].kind == "timeout"
    denied = ai.generate_explanations(TITLE, ABSTRACT, [CF], now=NOW + timedelta(minutes=6),
                                      session_usage=ledger)
    assert "five generation attempts" in denied.fair_use_notice
    assert not denied.attempts
    assert transport.call_count == 5


def test_fallback_counts_as_one_generation_action_and_two_provider_requests(transport):
    transport.side_effect = [error_response(), response("Groq")]
    ledger = {}
    result = ai.generate_explanations(TITLE, ABSTRACT, [CF, GROQ], now=NOW, session_usage=ledger)
    assert result.pack
    assert ledger["attempts"] == 1
    assert sum(attempt.request_sent for attempt in result.attempts) == 2


@pytest.mark.parametrize("unit", ["requests", "tokens"])
def test_success_with_reported_exhaustion_prevents_other_sessions_spending_a_request(unit, transport):
    transport.return_value = response("Groq", headers={
        f"x-ratelimit-remaining-{unit}": "0",
        f"x-ratelimit-reset-{unit}": "1h",
    })
    first = ai.generate_explanations(TITLE, ABSTRACT, [GROQ], now=NOW, session_usage={})
    assert first.pack
    assert first.attempts[0].blocked_until == NOW + timedelta(hours=1)
    second = ai.generate_explanations(TITLE, ABSTRACT, [GROQ], now=NOW, session_usage={})
    assert second.pack is None
    assert second.attempts[0].kind == "cooldown"
    transport.assert_called_once()
