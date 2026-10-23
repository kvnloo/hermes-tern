"""Hermes table_chart_planner.py route/limits with injected providers, no network."""
import importlib.util
import io
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "table_chart_planner.py"
TABLE = "| Name | Value |\n| --- | --- |\n| secret | 1 |\n| Beta | 2 |"


@pytest.fixture
def helper(monkeypatch):
    spec = importlib.util.spec_from_file_location("table_chart_planner_fixture", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # No real pm activation, Hermes client, credentials or network.
    monkeypatch.setitem(sys.modules, "pm", ModuleType("pm"))
    seen = []
    aux = ModuleType("agent.auxiliary_client")
    redact = ModuleType("agent.redact")
    agent = ModuleType("agent")
    agent.__path__ = []

    def redact_sensitive_text(text, *, force=False):
        assert force
        return text.replace("secret", "[redacted]")

    def call_llm(**kwargs):
        seen.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=kwargs["fixture"]))])

    # Use a real module boundary but inject a fake completion provider.
    aux.call_llm = call_llm
    redact.redact_sensitive_text = redact_sensitive_text
    monkeypatch.setitem(sys.modules, "agent", agent)
    monkeypatch.setitem(sys.modules, "agent.auxiliary_client", aux)
    monkeypatch.setitem(sys.modules, "agent.redact", redact)

    def invoke(request, answer="line", error=None):
        def complete(**kwargs):
            seen.append(kwargs)
            if error:
                raise error
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=answer))])

        aux.call_llm = complete
        monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
        return module.main()

    return invoke, seen


@pytest.mark.parametrize(("answer", "kind"), [
    ("bar", "bar"), ("line", "line"), ("none", "none"),
    ("BAR", "bar"), ("<svg />", "bar"), ("line\nexplanation", "bar"),
])
def test_only_enum_and_real_auxiliary_route(helper, answer, kind):
    invoke, seen = helper
    assert invoke({"source": TABLE}, answer) == {"kind": kind}
    assert len(seen) == 1
    req = seen[0]
    assert req["task"] == "table_charts"
    assert req["timeout"] == 5
    assert req["max_tokens"] == 64
    assert req["reasoning_config"] == {"enabled": False}
    assert "tools" not in req
    assert "secret" not in req["messages"][1]["content"]
    assert "[redacted]" in req["messages"][1]["content"]


@pytest.mark.parametrize("request", [{}, {"source": ""}, {"source": 42}, {"source": "x" * 8193}])
def test_invalid_inputs_never_reach_provider(helper, request):
    invoke, seen = helper
    assert invoke(request) == {"kind": "bar"}
    assert seen == []


def test_failure_or_unavailability_uses_local_bar_without_retry(helper):
    invoke, seen = helper
    assert invoke({"source": TABLE}, error=RuntimeError("offline")) == {"kind": "bar"}
    assert len(seen) == 1
