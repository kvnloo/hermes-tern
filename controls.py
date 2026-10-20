"""``ask_control``: a small question for the user, drawn as a native control in the Tern chat.

The agent asks with one of four controls: a choice (one or several of 2 to 8 options), a slider, a
confirm, or a pick from candidates. The pane draws it as a sheet the user answers with a number
key, the arrows and Enter, or a click (``frontend/src/controls``), and sends the answer as the
user's next message: ``Picked "SQLite" for: Which database? (db = sqlite)``. The tool itself does
not wait. It checks the control and returns at once, and the turn ends so the answer can arrive,
as a connect card's Continue does.

The control's shape is Ripple's fast-control schema (https://github.com/kvnloo/ripple,
``src/fast-controls``), which Ripple's other surfaces (Dash, the web) render too. :func:`parse_control`
is a port of its ``parseFastControl``; ``tests/test_controls.py`` runs it on Ripple's conformance
vectors (``frontend/src/vendor/ripple/vectors.json``) so the two never disagree.
"""

from __future__ import annotations

import re
from typing import Any

from . import connections

TOOL = "ask_control"
TOOLSET = "hermes-tern"

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
MAX_OPTIONS = 8
_LIMITS = {"prompt": 200, "label": 80, "detail": 160, "unit": 12, "confirmLabel": 40, "cancelLabel": 40}


class ControlError(ValueError):
    """A control outside the schema; the message says what to fix."""


def _text(value: Any, limit: int, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ControlError(f"{field} must be non-empty text")
    if len(value) > limit:
        raise ControlError(f"{field} is longer than {limit} characters")
    return value.strip()


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float("inf")


def _id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _ID.match(value):
        raise ControlError(f"{field} must be 1-64 letters, digits, '_', '.', ':' or '-', starting with a letter or digit")
    return value


def _options(raw: Any, field: str, keep_version: bool) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_OPTIONS:
        raise ControlError(f"{field} must list 2 to {MAX_OPTIONS} entries")
    out, seen = [], set()
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ControlError(f"{field}[{i}] must be an object with id and label")
        oid = _id(item.get("id"), f"{field}[{i}].id")
        if oid in seen:
            raise ControlError(f"{field} has the id {oid!r} twice")
        seen.add(oid)
        row: dict[str, Any] = {"id": oid, "label": _text(item.get("label"), _LIMITS["label"], f"{field}[{i}].label")}
        if item.get("detail") is not None:
            row["detail"] = _text(item["detail"], _LIMITS["detail"], f"{field}[{i}].detail")
        version = item.get("artifactVersion")
        if version is not None:
            if isinstance(version, bool) or not isinstance(version, int) or version < 1:
                raise ControlError(f"{field}[{i}].artifactVersion must be a whole number from 1")
            if keep_version:
                row["artifactVersion"] = version
        out.append(row)
    return out


def parse_control(raw: Any) -> dict[str, Any]:
    """``raw`` as a control in Ripple's schema, normalized (text trimmed, unknown fields dropped)."""
    if not isinstance(raw, dict):
        raise ControlError("the control must be an object")
    control: dict[str, Any] = {"id": _id(raw.get("id"), "id"), "kind": raw.get("kind"),
                               "prompt": _text(raw.get("prompt"), _LIMITS["prompt"], "prompt")}
    kind = raw.get("kind")
    if kind == "choice":
        control["options"] = _options(raw.get("options"), "options", keep_version=False)
        multiple = raw.get("multiple")
        if multiple is not None and not isinstance(multiple, bool):
            raise ControlError("multiple must be true or false")
        if multiple:
            control["multiple"] = True
    elif kind == "candidates":
        control["candidates"] = _options(raw.get("candidates"), "candidates", keep_version=True)
    elif kind == "slider":
        lo, hi, step, value = raw.get("min"), raw.get("max"), raw.get("step"), raw.get("value")
        if not _number(lo) or not _number(hi) or float(lo) >= float(hi):  # type: ignore[arg-type]
            raise ControlError("a slider needs numbers min < max")
        assert lo is not None and hi is not None
        control.update(min=lo, max=hi)
        if step is not None:
            if not _number(step) or step <= 0 or step > hi - lo:
                raise ControlError("step must be above 0 and no larger than max - min")
            control["step"] = step
        if value is not None:
            if not _number(value) or not lo <= value <= hi:
                raise ControlError("value must be a number between min and max")
            control["value"] = value
        if raw.get("unit") is not None:
            control["unit"] = _text(raw["unit"], _LIMITS["unit"], "unit")
    elif kind == "confirm":
        for field in ("confirmLabel", "cancelLabel"):
            if raw.get(field) is not None:
                control[field] = _text(raw[field], _LIMITS[field], field)
        if raw.get("detail") is not None:
            control["detail"] = _text(raw["detail"], _LIMITS["prompt"], "detail")
    else:
        raise ControlError("kind must be choice, slider, confirm or candidates")
    return control


_ROW = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "Short stable id, returned in the answer."},
        "label": {"type": "string", "description": "What the user reads (up to 80 characters)."},
        "detail": {"type": "string", "description": "One more line under the label (up to 160)."},
    },
    "required": ["id", "label"],
}

SCHEMA = {
    "name": TOOL,
    "description": (
        "Ask the user a small question as a native control in their Tern chat, instead of a question in "
        "your reply: pick one (or several) of 2-8 options, set a number on a slider, confirm or decline, or "
        "pick one of several candidates. They answer with a number key, the arrows and Enter, or a click. "
        "The tool returns at once; end your turn after calling it. The answer arrives as the user's next "
        "message, like 'Picked \"SQLite\" for: Which database? (db = sqlite)'. Use clarify instead when you "
        "need a typed answer or several questions at once."),
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Control id, e.g. 'db' (letters, digits, '_.:-'; up to 64)."},
            "kind": {"type": "string", "enum": ["choice", "slider", "confirm", "candidates"]},
            "prompt": {"type": "string", "description": "The question, one line (up to 200 characters)."},
            "options": {"type": "array", "items": _ROW, "description": "choice: 2-8 options, best first."},
            "multiple": {"type": "boolean", "description": "choice: the user may check several."},
            "candidates": {
                "type": "array", "description": "candidates: 2-8 artifacts to pick from.",
                "items": {**_ROW, "properties": {**_ROW["properties"], "artifactVersion": {"type": "integer", "minimum": 1}}},
            },
            "min": {"type": "number", "description": "slider: lowest value."},
            "max": {"type": "number", "description": "slider: highest value."},
            "step": {"type": "number", "description": "slider: increment (default (max-min)/100)."},
            "value": {"type": "number", "description": "slider: starting value (default the middle)."},
            "unit": {"type": "string", "description": "slider: unit shown after the value, e.g. 'ms'."},
            "confirmLabel": {"type": "string", "description": "confirm: the yes button (default Confirm)."},
            "cancelLabel": {"type": "string", "description": "confirm: the no button (default Cancel)."},
            "detail": {"type": "string", "description": "confirm: one more line under the question."},
        },
        "required": ["id", "kind", "prompt"],
    },
}


def ask_control(args: dict[str, Any], session_id: str | None = None) -> str:
    from tools.registry import tool_error, tool_result

    try:
        control = parse_control(args or {})
    except ControlError as error:
        return tool_error(f"ask_control: {error}")
    if not connections.viewed_by_tern(str(session_id or "")):
        return tool_error("No hermes tern pane shows this chat, so nobody can see the control. Ask in your "
                          "reply, or with clarify.")
    return tool_result({
        "shown": True,
        "control": control,
        "note": "The control is in front of the user. End your turn now; their answer arrives as their next message.",
    })


def register(ctx) -> None:
    ctx.register_tool(name=TOOL, toolset=TOOLSET, schema=SCHEMA, handler=ask_control, emoji="🎛️",
                      description=SCHEMA["description"])
