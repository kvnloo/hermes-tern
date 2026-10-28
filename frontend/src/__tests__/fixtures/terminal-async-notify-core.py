"""Exercise pinned async-delivery gate and completion envelope without spawning a process."""
import json
from types import SimpleNamespace

from gateway.run_turn_progress import _tool_complete_payload
from gateway.session_context import clear_session_vars, set_session_vars
from tools.terminal_tool_background import _apply_async_support


def event(notify, patterns):
    result = {"output": "Background process started", "session_id": "synthetic-process",
              "pid": 123, "exit_code": 0, "error": None}
    tokens = set_session_vars(platform="api_server", chat_id="synthetic",
                              session_key="synthetic", async_delivery=False)
    try:
        effective = _apply_async_support(SimpleNamespace(id="synthetic-process"), result, notify, patterns)
        assert effective == (False, None)
    finally:
        clear_session_vars(tokens)
    args = {"command": "make test", "background": True}
    if notify:
        args["notify_on_complete"] = True
    if patterns:
        args["watch_patterns"] = patterns
    return _tool_complete_payload("c1", "terminal", args, json.dumps(result), is_error=False)


print(json.dumps([event(True, None), event(False, ["READY"])]))
