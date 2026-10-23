"""Real green Hermes JSON-RPC registry and authorization pipeline gates.

Run with PYTHONPATH set to Hermes PR650's exact source checkout. The tests use
temporary profile homes, fake transports and fake Tern CLI; no live panes or
clean user profile are read or mutated.
"""
from __future__ import annotations

import asyncio
import importlib
import json
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
    from tui_gateway import server
    from hermes_cli import plugins
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
    assert names == sorted([
        "hermes-tern.browser.blocks", "hermes-tern.browser.adopt",
        "hermes-tern.browser.focus", "hermes-tern.browser.release",
        "hermes-tern.browser.frame",
    ])

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



class ActiveCLI:
    """No subprocesses; counts real registered-dispatch CLI effects exactly."""
    instances = []

    def __init__(self, *_args):
        self.calls = []
        self.unknown = False
        self.pending = None
        self.instances.append(self)

    def __call__(self, op):
        self.calls.append(dict(op))
        action = op["op"]
        if action == "blocks":
            return {"blocks": [{"block": 7, "title": "Owned test page",
                                "url": "https://example.org/", "owner": None,
                                "driven": False}]}
        if action == "snapshot":
            return {"text": "document"}
        if action == "state":
            return {"title": "Owned test page", "url": "https://example.org/"}
        if action in {"release", "close"}:
            return {"released": True}
        if action == "eval":
            return {"value": "https://example.org/"}
        raise AssertionError(f"unexpected native operation: {action}")

    def invoke(self, argv):
        self.calls.append({"focus": list(argv)})
        return {}


def _consent(home, enabled: bool):
    """Write the isolated profile through Hermes' real config API (cache invalidation)."""
    from hermes_cli.config import save_config

    assert home.is_dir()
    save_config({"plugins": {"entries": {
        "hermes-tern": {"allow_tool_override": enabled},
    }}}, strip_defaults=False)


def _reload_granted(manager, plugins, home, monkeypatch):
    from tools.registry import registry

    importlib.import_module("tools.browser_tool")
    _consent(home, True)
    assert manager.unload("hermes-tern")
    ActiveCLI.instances.clear()
    monkeypatch.setattr(backend, "TernBrowserCLI", ActiveCLI)
    ctx = plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager)
    assert ctx.has_capability("tools.override") is True
    backend.register(ctx)
    for name in backend._TOOL_NAMES:
        selected = registry.get_entry(name)
        assert selected is not None
        assert selected.handler is backend._NATIVE_HANDLERS[ctx.profile_name][name]
    return ctx


def test_public_context_consent_grant_revoke_reload_and_registry_identity(green, monkeypatch):
    """Consent appearing later cannot silently enable a CLI backend with old handlers."""
    from hermes_cli import plugins
    from tools.registry import registry

    server, manager, _, home = green
    importlib.import_module("tools.browser_tool")
    original = {name: registry.get_entry(name).handler for name in backend._TOOL_NAMES}
    peer = Peer()
    attach(server, "s1", peer)
    absent = plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager)
    assert absent.has_capability("tools.override") is False
    _consent(home, True)
    assert absent.has_capability("tools.override") is True
    assert all(registry.get_entry(name).handler is old for name, old in original.items())
    still_missing = rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")
    assert still_missing["result"]["reason"] == "needs_plugin_reload"
    assert still_missing["result"]["available"] is False
    assert still_missing["result"]["blocks"][0]["target_id"] == "7"
    assert native.get_driver("default", "s1") is None
    denied = rpc(server, peer, "hermes-tern.browser.adopt", session_id="s1", target_id="7")
    assert denied["error"]["code"] == -32000
    assert all(registry.get_entry(name).handler is old for name, old in original.items())

    ctx = _reload_granted(manager, plugins, home, monkeypatch)
    assert rpc(server, peer, "hermes-tern.browser.blocks", session_id="s1")["result"]["available"] is True
    driver = native.get_driver("default", "s1")
    assert driver is not None and driver.scope.lease is not None
    assert ActiveCLI.instances[0].calls == [{"op": "blocks"}]
    adopted = rpc(server, peer, "hermes-tern.browser.adopt", session_id="s1", target_id="7")
    assert adopted["result"]["target_id"] == "7"
    assert driver.scope.cli is ActiveCLI.instances[0]
    initial = list(driver.scope.cli.calls)

    _consent(home, False)
    assert ctx.has_capability("tools.override") is False
    refused = rpc(server, peer, "hermes-tern.browser.focus", session_id="s1", target_id="7")
    assert refused["error"]["code"] == -32000
    selected = registry.get_entry("browser_click")
    assert selected is not None and selected.handler is backend._NATIVE_HANDLERS["default"]["browser_click"]
    tool = json.loads(selected.handler({"ref": "@e1"}, session_id="s1", task_id="s1"))
    assert tool["error_kind"] == "unsupported"
    assert driver.scope.cli.calls == initial  # not a native focus or wrong-backend effect

    assert manager.unload("hermes-tern")
    assert all(registry.get_entry(name).handler is old for name, old in original.items())
    assert "default" not in backend._NATIVE_HANDLERS
    reloaded_without_grant = plugins.PluginContext(
        plugins.PluginManifest(name="hermes-tern"), manager)
    backend.register(reloaded_without_grant)
    assert all(registry.get_entry(name).handler is old for name, old in original.items())


def test_real_legacy_original_caller_survives_mirror_denial_then_detach(green, monkeypatch):
    """Original lease and effects through the real registered legacy dispatcher."""
    from tui_gateway.transport import FanoutTransport

    server, manager, plugins, home = green
    _reload_granted(manager, plugins, home, monkeypatch)
    a, b = Peer(), Peer()
    fanout = FanoutTransport(a, b)
    attach(server, "s1", fanout)
    assert rpc(server, a, "hermes-tern.browser.blocks", session_id="s1")["result"]["available"] is True
    driver = native.get_driver("default", "s1")
    lease = driver.scope.lease
    calls = list(driver.scope.cli.calls)

    for action, parameters in (
        ("blocks", {}),
        ("adopt", {"target_id": "7"}),
        ("focus", {"target_id": "7"}),
        ("release", {"target_id": "7"}),
        ("frame", {"target_id": "7", "frame": "main"}),
    ):
        result = rpc(server, b, f"hermes-tern.browser.{action}", session_id="s1", **parameters)
        assert result["error"]["code"] == -32000, result
    assert driver.scope.cli.calls == calls
    assert native.get_driver("default", "s1").scope.lease is lease
    assert rpc(server, a, "hermes-tern.browser.adopt",
               session_id="s1", target_id="7")["result"]["target_id"] == "7"
    assert native.get_driver("default", "s1").scope.lease is lease
    assert rpc(server, a, "hermes-tern.browser.focus",
               session_id="s1", target_id="7")["result"]["in_tern"] is True
    assert {"focus": ["focus", "7", "--json"]} in driver.scope.cli.calls

    assert fanout.detach(a)
    assert fanout.attach(a)
    calls = list(driver.scope.cli.calls)
    assert rpc(server, a, "hermes-tern.browser.release",
               session_id="s1", target_id="7")["error"]["code"] == -32000
    assert driver.scope.cli.calls == calls

    # The legacy session record is no longer active. Neither a stale peer
    # nor another viewer may issue an RPC effect after the slot disappears.
    server._sessions.pop("s1")
    assert rpc(server, b, "hermes-tern.browser.focus",
               session_id="s1", target_id="7")["error"]["code"] == 4001
    assert driver.scope.cli.calls == calls


@pytest.mark.parametrize("revocation", ["generation", "real_rewind"])
@pytest.mark.asyncio
async def test_real_canonical_original_caller_and_generation(green, monkeypatch, revocation):
    """Real canonical router; the temporary task/busy witness is fixture-only.

    Production canonical sessions without a trusted task accessor stay read-only.
    The mock owner supplies only this orthogonal task fence: the core still binds
    both real WS peers via its own public GatewayScopeLease.assert_caller.
    """
    from gateway.session_authority import LiveSession, SessionAuthority
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch
    from tui_gateway.ws import _authority_connection, _dispatch_request

    _, manager, plugins, home = green
    _reload_granted(manager, plugins, home, monkeypatch)
    db = SessionDB(db_path=home / "state.db")
    db.create_session("canon", source="test")
    runner = SimpleNamespace(_draining=False, config=SimpleNamespace(multiplex_profiles=False))
    authority = SessionAuthority(
        runner, profile_id=str(home), instance_id="isolated", db=db,
        epoch=begin_runtime_epoch(db, instance_id="isolated"),
    )
    authority.sessions["canon"] = LiveSession(None, "route")

    class Transport:
        def __init__(self):
            self.frames = []
            self.closed = False

        def write(self, frame):
            if self.closed:
                return False
            self.frames.append(frame)
            return True

    def connect(subject):
        identity = {
            "user_id": subject, "provider": "local", "native_bootstrap": True,
            "profile_id": authority.profile_id, "instance_id": authority.instance_id,
        }
        return _authority_connection(
            SimpleNamespace(scope={"hermes.session_authority": authority}),
            Transport(), identity, operator=True,
        )

    async def call(peer, method, **params):
        return await _dispatch_request(
            peer, {"jsonrpc": "2.0", "id": 1, "method": method,
                   "params": params}, method, peer.transport,
        )

    a, b = connect("a"), connect("b")
    try:
        for peer in (a, b):
            assert "result" in await call(peer, "session.resume", session_id="canon")
        # The unmodified production canonical path has no trustworthy task
        # projection, so genuine attached discovery cannot claim a controller.
        initial = await call(a, "hermes-tern.browser.blocks", session_id="canon")
        assert initial["result"]["available"] is False, initial
        assert initial["result"]["reason"] == "operator_consent_or_task_authority_required"
        assert native.get_driver("default", "canon") is None
        # Only the orthogonal task/busy authority is supplied by this fixture;
        # caller and admission are enforced by the real core dispatcher.
        monkeypatch.setattr(backend, "_legacy_owner", lambda sid, profile: (
            {"session_key": "canon", "running": False}
            if sid == "canon" and profile == "default" else None
        ))
        first = await call(a, "hermes-tern.browser.blocks", session_id="canon")
        assert first["result"]["available"] is True, first
        driver = native.get_driver("default", "canon")
        lease = driver.scope.lease
        calls = list(driver.scope.cli.calls)
        for action, params in (
            ("blocks", {}),
            ("adopt", {"target_id": "7"}),
            ("focus", {"target_id": "7"}),
        ):
            refused = await call(b, f"hermes-tern.browser.{action}",
                                 session_id="canon", **params)
            assert refused["error"]["code"] == -32000, refused
        assert driver.scope.cli.calls == calls
        assert native.get_driver("default", "canon").scope.lease is lease
        owned = await call(a, "hermes-tern.browser.adopt", session_id="canon", target_id="7")
        assert owned["result"]["target_id"] == "7", owned
        assert driver.scope.lease is lease

        if revocation == "generation":
            db._execute_write(lambda conn: conn.execute(
                "UPDATE sessions SET runtime_generation=runtime_generation+1 WHERE id=?",
                ("canon",),
            ))
        else:
            runner._evict_cached_agent = lambda route: None
            target_id = await asyncio.to_thread(
                db.append_message, "canon", "user", "browser rewind target")
            snapshot = await asyncio.to_thread(db.get_session, "canon")
            rewind = await call(
                a, "session.mutate", session_id="canon",
                request_id="browser-caller-rewind",
                expected_revision=snapshot["runtime_revision"],
                expected_generation=snapshot["runtime_generation"],
                operation="rewind", payload={"target_message_id": target_id},
            )
            assert "result" in rewind, rewind
            assert rewind["result"]["execution_generation"] == (
                snapshot["runtime_generation"] + 1
            )
        calls = list(driver.scope.cli.calls)
        stale = await call(a, "hermes-tern.browser.focus", session_id="canon", target_id="7")
        assert stale["error"]["code"] in {4001, -32000}, stale
        assert driver.scope.cli.calls == calls
        assert native.get_driver("default", "canon").scope.lease is lease
    finally:
        await a.close()
        await b.close()
        db.close()


@pytest.mark.parametrize("denial", ["scope", "pre_hook", "guardrail"])
def test_real_hermes_policy_deny_before_native_effect(monkeypatch, denial):
    from agent import tool_executor as executor
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
