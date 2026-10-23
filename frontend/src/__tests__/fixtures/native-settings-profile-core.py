#!/usr/bin/env python3
"""Exercise the actual pinned tui_gateway.server direct JSON-RPC dispatcher in isolated profile homes.

This intentionally invokes real config.get/set handlers and reads files; it does
not replace the handlers with a params-echo fake or patch the core profile resolver.
"""
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

with TemporaryDirectory(prefix="hermes-tern-profile-owner-") as directory:
    home = Path(directory) / "launch"
    a = home / "profiles" / "a"
    b = home / "profiles" / "b"
    for root, busy in ((home, "queue"), (a, "queue"), (b, "interrupt")):
        root.mkdir(parents=True, exist_ok=True)
        (root / "config.yaml").write_text(
            "display:\n  busy_input_mode: " + busy + "\n", encoding="utf-8"
        )

    # OMP supplies the pinned Hermes source and its Python dependencies.
    source = Path.cwd() / ".hermes-src"
    if not (source / "tui_gateway" / "server.py").is_file():
        raise RuntimeError("Missing pinned Hermes source. Run node scripts/hermes-src.mjs.")
    sys.path.insert(0, str(source))
    os.environ["HERMES_HOME"] = str(home)

    from tui_gateway import server
    from tui_gateway.ws_legacy_fallback import _connection_profile_home

    def call(method, params):
        # Actual registered synchronous JSON-RPC admission, contract and handler;
        # not a ticket-bound WS authority transport.
        response = server._handle_admitted_request({
            "jsonrpc": "2.0", "id": 7, "method": method, "params": params
        })
        if not isinstance(response, dict) or "result" not in response:
            raise AssertionError(f"Actual pinned gateway rejected {method}: {response!r}")
        return response["result"]

    def value(root):
        import hermes_yaml as yaml
        return yaml.safe_load(
            (root / "config.yaml").read_text(encoding="utf-8")
        )["display"]["busy_input_mode"]

    # Profile A was live; its runtime id is reaped before the next read.
    # The actual direct dispatcher now falls back to connection B if profile is absent.
    server._sessions["reaped-A"] = {
        "agent": None, "profile_home": str(a), "session_key": "reaped-A"
    }
    server._sessions.pop("reaped-A")
    token = _connection_profile_home.set(str(b))
    try:
        params = {"key": "busy", "session_id": "reaped-A", "profile": "a"}
        owner_read = call("config.get", params)["value"]
        fallback_read = call("config.get", {"key": "busy", "session_id": "reaped-A"})["value"]
        written = call("config.set", {**params, "value": "steer"})
        readback = call("config.get", params)["value"]
        assert owner_read == "queue" and fallback_read == "interrupt"
        assert written["key"] == "busy" and written["value"] == "steer"
        assert readback == "steer"
        assert (value(a), value(b), value(home)) == ("steer", "interrupt", "queue")
    finally:
        _connection_profile_home.reset(token)
        server._sessions.pop("reaped-A", None)

    print(json.dumps({
        "pinned": True, "ownerRead": owner_read, "fallbackRead": fallback_read,
        "readback": readback, "a": value(a), "b": value(b), "launch": value(home)
    }))
