"""Provider fixture for a real Python subprocess driven by Vitest (never network)."""
import os
import time
from types import SimpleNamespace


class AuxiliaryClientUnavailable(RuntimeError):
    pass


def call_llm(**kwargs):
    assert kwargs["task"] == "table_charts"
    assert kwargs["max_tokens"] == 64
    assert kwargs["timeout"] == 5
    assert kwargs["reasoning_config"] == {"enabled": False}
    assert "tools" not in kwargs
    assert len(kwargs["messages"]) == 2
    assert "secret" not in kwargs["messages"][1]["content"]

    scenario = os.environ.get("TABLE_CHART_FIXTURE_OUTPUT", "line")
    if scenario == "raise":
        raise RuntimeError("fixture provider failed")
    if scenario == "unavailable":
        raise AuxiliaryClientUnavailable("fixture provider unavailable")
    if scenario == "slow":
        time.sleep(10)
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=scenario))])
