"""Real green Hermes JSON-RPC registry and authorization pipeline gates.

Run with PYTHONPATH set to Hermes PR650's exact source checkout. The tests use
temporary profile homes, fake transports and fake Tern CLI; no live panes or
clean user profile are read or mutated.
"""
from __future__ import annotations

import queue
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_tern_plugin import browser_backend as backend
from hermes_tern_plugin import browser_native as native


class Peer:
    def __init__(self):
        self.frames = queue.Queue()
        self.closed = False

    def write(self, frame):
        if self.closed:
            return False
        self.frames.put(frame)
        return True

    def receive(self):
        return self.frames.get(timeout=5)

    def close(self):
        self.closed = True


class ReadOnlyCLI:
    calls = 0

    def __init__(self, *_args):
        pass

    def __call__(self, op):
        type(self).calls += 1
        assert op == {"op": "blocks"}
        return {"blocks": [{
            "block": 7, "title": "Private title", "url": "https://example.org/",
            "owner": None, "driven": False,
        }]}


def attach(server, sid, peer, home=None):
    server._sessions[sid] = {
        "transport": peer, "profile_home": home, "session_key": sid,
        "history": [], "history_lock": threading.Lock(), "running": False,
    }


def rpc(server, peer, method, rid=1, **params):
    message = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
    immediate = server.dispatch(message, peer)
    return peer.receive() if immediate is None else immediate


@pytest.fixture
def green(tmp_path, monkeypatch):
    server = pytest.importorskip("tui_gateway.server")
    plugins = pytest.importorskip("hermes_cli.plugins")
    from hermes_tern_plugin import tern_env

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_sessions", {})
    plugins._reset_plugin_managers_for_tests()
    monkeypatch.setattr(plugins, "discover_plugins", lambda force=False: None)

    ReadOnlyCLI.calls = 0
    monkeypatch.setattr(backend, "TernBrowserCLI", ReadOnlyCLI)
    monkeypatch.setattr(backend, "_cdp_selected", lambda: False)
    view = {"TERN_PANE": "3", "TERN_WINDOW_KEY": "isolated-window"}
    monkeypatch.setattr(tern_env, "pane_env", lambda sid: dict(view))
    monkeypatch.setattr(backend, "_viewer", lambda sid: (
        3, "isolated-window", tuple(sorted(view.items())),
        {"HOME": str(home)}, "tern", ("isolated-window", "daemon", "config"),
    ))

    manager = plugins.get_plugin_manager()
    ctx = plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager)
    backend.register(ctx)
    yield server, manager, plugins, home
    manager.unload("hermes-tern")
    plugins._reset_plugin_managers_for_tests()
    native._DRIVERS.clear()


def test_real_registered_plugin_names_and_live_transport(green):
    server, manager, _, _ = green
    attached = Peer()
    foreign = Peer()
    attach(server, "s1", attached)
    attach(server, "s2", foreign)
    names = rpc(server, attached, "gateway.capabilities", session_id="s1")["result"]["plugin_methods"]
    assert names == [f"hermes-tern.browser.{n}" for n in backend.METHODS]

    found = rpc(server, attached, "hermes-tern.browser.blocks", session_id="s1")
    assert found["result"]["available"] is False  # no operator tool override grant
    assert found["result"]["blocks"][0]["target_id"] == "7"
    assert ReadOnlyCLI.calls == 1
    assert rpc(server, foreign, "hermes-tern.browser.blocks", session_id="s1")["error"]["code"] == 4001
    assert rpc(server, attached, "gateway.capabilities", session_id="s2")["error"]["code"] == 4001
    assert rpc(server, attached, "hermes-tern.browser.adopt", session_id="s1",
               target_id="7")["error"]["code"] in {4001, -32000}
    assert ReadOnlyCLI.calls == 1  # refusal had NO native adoption


def test_real_registered_plugin_refuses_client_profile_and_detach(green):
    server, manager, _, _ = green
    peer = Peer()
    attach(server, "s1", peer)
    for method in ("gateway.capabilities", "hermes-tern.browser.blocks"):
        reply = rpc(server, peer, method, session_id="s1", profile="other")
        assert reply["error"]["code"] == 4001
    old = server._sessions.pop("s1")
    assert rpc(server, peer, "hermes-tern.browser.blocks",
               session_id="s1")["error"]["code"] == 4001
    attach(server, "s1", Peer())
    assert rpc(server, peer, "hermes-tern.browser.blocks",
               session_id="s1")["error"]["code"] == 4001
    assert ReadOnlyCLI.calls == 0


def test_real_registered_plugin_isolated_second_profile(green):
    server, manager, plugins, home = green
    one = Peer()
    two = Peer()
    profile_home = home / "profiles" / "work"
    profile_home.mkdir(parents=True)
    (profile_home / "config.yaml").write_text("{}\n", encoding="utf-8")
    attach(server, "default-owned", one)
    attach(server, "work-owned", two, str(profile_home))
    names = rpc(server, one, "gateway.capabilities",
                session_id="default-owned")["result"]["plugin_methods"]
    assert "hermes-tern.browser.blocks" in names
    foreign_methods = rpc(server, two, "gateway.capabilities",
                          session_id="work-owned")["result"]["plugin_methods"]
    assert "hermes-tern.browser.blocks" not in foreign_methods
    assert rpc(server, two, "hermes-tern.browser.blocks",
               session_id="work-owned")["error"]["code"] == -32601
    assert rpc(server, one, "hermes-tern.browser.blocks",
               session_id="work-owned")["error"]["code"] == 4001


def test_real_gateway_unload_revokes_registration(green):
    server, manager, _, _ = green
    peer = Peer()
    attach(server, "s1", peer)
    assert rpc(server, peer, "gateway.capabilities",
               session_id="s1")["result"]["plugin_methods"]
    assert manager.unload("hermes-tern")
    assert rpc(server, peer, "gateway.capabilities",
               session_id="s1")["result"]["plugin_methods"] == []
    assert rpc(server, peer, "hermes-tern.browser.blocks",
               session_id="s1")["error"]["code"] == -32601


@pytest.mark.parametrize("denial", ["scope", "pre_hook", "guardrail"])
def test_real_hermes_policy_deny_before_native_effect(monkeypatch, denial):
    executor = pytest.importorskip("agent.tool_executor")
    effects = []
    posts = []
    monkeypatch.setattr(executor, "_emit_terminal_post_tool_call",
                        lambda *args, **kwargs: posts.append(kwargs))
    denied = SimpleNamespace(allows_execution=False, message="denied")
    agent = SimpleNamespace(
        _tool_guardrails=SimpleNamespace(
            before_call=lambda name, args: denied if denial == "guardrail"
            else SimpleNamespace(allows_execution=True)),
        _guardrail_block_result=lambda decision: '{"error":"denied"}',
    )
    monkeypatch.setattr(
        executor, "_pre_tool_block",
        lambda agent, ref: ("hook rejected", ref.args) if denial == "pre_hook"
        else (None, ref.args),
    )
    args = {"ref": "@e1"}
    state = executor._ManagedToolResult(
        result=None, args=args, middleware_trace=[], blocked=False, dispatched=False,
    )
    ref = executor._ToolCallRef("browser_click", args, "task", "call", [])
    result = executor._dispatch_authorized_once(
        agent, state, ref,
        execute=lambda kwargs: effects.append(kwargs),
        scope_block="scope denied" if denial == "scope" else None,
        display_index=None, begin_execution=None, authorization_gate=None,
    )
    assert "denied" in str(result) or "rejected" in str(result)
    assert state.blocked
    assert not effects
    assert len(posts) == 1
