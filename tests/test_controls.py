"""``ask_control``: the control schema matches Ripple's (its conformance vectors), and the tool only
shows a control a live ``hermes tern`` pane can draw."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

from hermes_tern_plugin import connections, controls

VECTORS = json.loads((Path(__file__).resolve().parents[1] / "frontend/src/vendor/ripple/vectors.json").read_text())


def _raw(case):
    return VECTORS["controls"][case["raw"]] if isinstance(case["raw"], str) else case["raw"]


@pytest.mark.parametrize("case", VECTORS["parse"], ids=[c["name"] for c in VECTORS["parse"]])
def test_parse_matches_ripples_vectors(case):
    raw = _raw(case)
    if not case["ok"]:
        with pytest.raises(controls.ControlError):
            controls.parse_control(raw)
        return
    assert controls.parse_control(raw) == case.get("normalized", raw)


def test_errors_say_what_to_fix():
    with pytest.raises(controls.ControlError, match="2 to 8"):
        controls.parse_control({"id": "c", "kind": "choice", "prompt": "Pick", "options": [{"id": "a", "label": "A"}]})
    with pytest.raises(controls.ControlError, match="kind must be"):
        controls.parse_control({"id": "c", "kind": "html", "prompt": "Pick"})


def test_absent_optional_fields_may_come_as_null():
    control = controls.parse_control({"id": "s", "kind": "slider", "prompt": "How much?", "min": 0, "max": 10,
                                      "step": None, "unit": None, "options": None})
    assert control == {"id": "s", "kind": "slider", "prompt": "How much?", "min": 0, "max": 10}


@pytest.fixture
def registry(monkeypatch):
    """The two helpers the handler imports from core."""
    module = types.ModuleType("tools.registry")
    module.tool_error = lambda message: json.dumps({"error": message})
    module.tool_result = lambda data: json.dumps(data)
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.registry", module)


def test_a_control_shows_in_a_chat_a_tern_pane_views(registry, monkeypatch):
    monkeypatch.setattr(connections, "viewed_by_tern", lambda sid: sid == "s1")
    out = json.loads(controls.ask_control(VECTORS["controls"]["db"], session_id="s1"))
    assert out["shown"] is True
    assert out["control"] == VECTORS["controls"]["db"]
    assert "End your turn" in out["note"]


def test_no_pane_no_control(registry, monkeypatch):
    monkeypatch.setattr(connections, "viewed_by_tern", lambda sid: sid == "s1")
    out = json.loads(controls.ask_control(VECTORS["controls"]["db"], session_id="s2"))
    assert "No hermes tern pane" in out["error"]


def test_a_bad_control_is_an_error_the_model_can_fix(registry):
    out = json.loads(controls.ask_control({"id": "x", "kind": "slider", "prompt": "p", "min": 3, "max": 1}, session_id="s1"))
    assert out["error"].startswith("ask_control: a slider needs numbers min < max")


def test_the_schema_lists_every_field_the_parser_reads():
    props = set(controls.SCHEMA["parameters"]["properties"])
    assert props == {"id", "kind", "prompt", "options", "multiple", "candidates", "min", "max", "step", "value", "unit",
                     "confirmLabel", "cancelLabel", "detail"}
