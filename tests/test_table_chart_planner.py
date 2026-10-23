"""Real single-attempt Hermes auxiliary transport; local HTTP fixture, never a model."""
from __future__ import annotations

import io
import json
import sys
import threading
import time

import httpx
import pytest
from openai import OpenAI

from hermes_tern_plugin import table_chart_planner as planner

TABLE = "| Name | Value |\n| --- | --- |\n| secret | 1 |\n| Beta | 2 |"


@pytest.fixture
def provider(monkeypatch):
    from agent import auxiliary_client, redact

    calls: list[dict] = []
    statuses = {"status": 200, "answer": "line"}

    def exchange(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        calls.append(payload)
        if statuses["status"] != 200:
            return httpx.Response(statuses["status"], json={
                "error": {"message": "fixture failure", "type": "invalid_request_error"}
            })
        return httpx.Response(200, json={
            "id": "fixture", "object": "chat.completion", "created": 1,
            "model": "fixture-model", "choices": [{
                "index": 0, "finish_reason": "stop",
                "message": {"role": "assistant", "content": statuses["answer"]},
            }],
        })

    client = OpenAI(
        api_key="local-fixture", base_url="https://fixture.invalid/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(exchange)),
        max_retries=2,  # The helper MUST replace this with zero on each send.
    )
    monkeypatch.setattr(auxiliary_client, "get_text_auxiliary_client",
                        lambda task: (client, "fixture-model") if task == "table_charts" else (None, None))

    def redact_source(text, *, force=False):
        assert force is True
        return text.replace("secret", "[redacted]")

    monkeypatch.setattr(redact, "redact_sensitive_text", redact_source)
    return statuses, calls


@pytest.mark.parametrize(("answer", "kind"), [
    ("bar", "bar"), ("line", "line"), ("none", "none"),
    ("BAR", "bar"), ("<svg/>", "bar"), ("line\nmore", "bar"),
])
def test_real_relay_single_transport_and_enum(provider, answer, kind):
    statuses, calls = provider
    statuses["answer"] = answer
    assert planner._classify(TABLE) == kind
    assert len(calls) == 1
    payload = calls[0]
    assert payload["model"] == "fixture-model"
    token_keys = [key for key in ("max_tokens", "max_completion_tokens") if key in payload]
    assert len(token_keys) == 1 and payload[token_keys[0]] == 64
    assert "secret" not in payload["messages"][1]["content"]
    assert "[redacted]" in payload["messages"][1]["content"]
    assert len(payload["messages"]) == 2


@pytest.mark.parametrize("status", [400, 401, 402, 408, 429, 500, 503])
def test_every_provider_failure_is_one_physical_attempt(provider, status):
    statuses, calls = provider
    statuses["status"] = status
    assert planner._classify(TABLE) == "bar"
    assert len(calls) == 1
    assert calls[0].get("max_tokens", calls[0].get("max_completion_tokens")) == 64


@pytest.mark.parametrize("source", [
    "", "not a table", "| a | b |\n| --- | --- |\n| label | 0 |\n| other | 0 |",
    "| A | B |\n| --- | --- |\n| <img> | 1 |\n| Other | 2 |",
    "| A | B |\n| --- | --- |\n| 1 | 1 |\n| 2 | 2 |",
    "| A | B |\n| --- | --- |\n| X | 1 |\n| X | 2 |",
    "x" * 8193,
])
def test_invalid_source_never_resolves_or_sends(provider, source):
    _statuses, calls = provider
    assert planner._classify(source) == "bar"
    assert calls == []


def test_invalid_wire_cap_refused_before_network(provider, monkeypatch):
    from agent import auxiliary_client

    _statuses, calls = provider
    monkeypatch.setattr(auxiliary_client, "auxiliary_max_tokens_param",
                        lambda count, *, model=None: {})
    assert planner._classify(TABLE) == "bar"
    assert calls == []


def test_unsupported_provider_without_retry_contract_has_no_send(provider, monkeypatch):
    from agent import auxiliary_client

    _statuses, calls = provider

    class UnknownClient:
        chat = object()

    monkeypatch.setattr(auxiliary_client, "get_text_auxiliary_client",
                        lambda task: (UnknownClient(), "fixture-model"))
    assert planner._classify(TABLE) == "bar"
    assert calls == []


def test_stdin_contract_rejects_invalid_without_provider(provider, monkeypatch):
    _statuses, calls = provider
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"source": 45})))
    assert planner.main() == {"kind": "bar"}
    assert calls == []


def test_worker_observes_deadline_without_retry(provider, monkeypatch):
    from agent import auxiliary_client

    _statuses, calls = provider
    gate = threading.Event()
    entered = threading.Event()

    # Inject a real HTTP transport, not a fake call_llm completion.
    def exchange(request):
        calls.append(json.loads(request.content))
        entered.set()
        gate.wait(10)
        return httpx.Response(200, json={
            "id": "late", "object": "chat.completion", "created": 1,
            "model": "fixture-model", "choices": [{
                "index": 0, "finish_reason": "stop",
                "message": {"role": "assistant", "content": "line"},
            }],
        })

    client = OpenAI(api_key="local", base_url="https://fixture.invalid/v1",
                    http_client=httpx.Client(transport=httpx.MockTransport(exchange)),
                    max_retries=2)
    monkeypatch.setattr(auxiliary_client, "get_text_auxiliary_client",
                        lambda task: (client, "fixture-model"))
    start = time.monotonic()
    try:
        assert planner._classify(TABLE) == "bar"
        assert time.monotonic() - start <= planner.DEADLINE_SECONDS + 0.75
        assert entered.is_set()
        assert len(calls) == 1
    finally:
        gate.set()
