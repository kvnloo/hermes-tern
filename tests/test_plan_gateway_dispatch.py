"""Actual legacy and canonical dispatcher regressions for fail-closed plan RPCs.

Run against the Hermes core containing the public plugin gateway method seam,
not the older frontend/hermes-src.lock checkout. No mocked dispatcher result
may stand in for runtime enforcement or successful plan completion.
"""

from __future__ import annotations

import asyncio
import queue
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

import hermes_tern_plugin.plan_gateway as plan_gateway


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


@pytest.fixture
def legacy(tmp_path, monkeypatch):
    from hermes_cli import plugins
    from tui_gateway import server

    home = tmp_path / "legacy-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_sessions", {})
    plugins._reset_plugin_managers_for_tests()
    monkeypatch.setattr(plugins, "discover_plugins", lambda force=False: None)
    manager = plugins.get_plugin_manager()
    ctx = plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager)
    plan_gateway.register(ctx)
    yield server, manager
    plugins._reset_plugin_managers_for_tests()


def _legacy_call(server, peer, method, **params):
    answer = server.dispatch(
        {"jsonrpc": "2.0", "id": 19, "method": method, "params": params}, peer)
    return peer.receive() if answer is None else answer


def test_legacy_real_dispatch_never_invents_authority_or_equates_ids(legacy):
    server, _manager = legacy
    owner, other = Peer(), Peer()
    # The live RPC sid is NOT the durable owner/agent session key.
    server._sessions["live-A"] = {
        "transport": owner, "profile_home": None, "session_key": "durable-task-Z",
        "history": [], "history_lock": threading.Lock(), "running": False,
    }
    status = _legacy_call(server, owner, "hermes-tern.plan.status", session_id="live-A")
    assert status["result"] == {
        "supported": False, "reason": plan_gateway.AUTHORITY_REQUIRED}
    assert "plan" not in status["result"]
    assert _legacy_call(server, other, "hermes-tern.plan.status",
                        session_id="live-A")["error"]["code"] == 4001
    assert _legacy_call(server, owner, "hermes-tern.plan.status",
                        session_id="durable-task-Z")["error"]["code"] == 4001
    for verb, payload in (
        ("mode", {"enabled": True}),
        ("edit", {"plan_id": "fake", "revision": 1, "text": "execute"}),
        ("annotate", {"plan_id": "fake", "revision": 1, "section": 0, "text": "note"}),
        ("decide", {"plan_id": "fake", "revision": 1, "intent": "approve"}),
    ):
        refused = _legacy_call(server, owner, "hermes-tern.plan." + verb,
                               session_id="live-A", **payload)
        assert refused["error"]["code"] == 4094, refused
    assert "plan_review" not in server._sessions["live-A"]
    assert server._sessions["live-A"]["running"] is False


def test_legacy_real_gateway_validation_detach_and_unload(legacy):
    server, manager = legacy
    peer = Peer()
    server._sessions["live"] = {
        "transport": peer, "profile_home": None, "session_key": "stored",
        "history": [], "history_lock": threading.Lock(), "running": False,
    }
    cap = _legacy_call(server, peer, "gateway.capabilities", session_id="live")
    assert set(plan_gateway.NAMESPACE + "." + v
               for v in ("status", "mode", "edit", "annotate", "decide")).issubset(
                   set(cap["result"]["plugin_methods"]))
    for payload in ({"enabled": "true"}, {"enabled": True, "profile": "other"},
                    {"enabled": True, "extraneous": True}):
        rejected = _legacy_call(server, peer, "hermes-tern.plan.mode",
                                session_id="live", **payload)
        assert rejected["error"]["code"] in (4001, -32602), rejected
    server._sessions.pop("live")
    assert _legacy_call(server, peer, "hermes-tern.plan.status",
                        session_id="live")["error"]["code"] == 4001
    assert manager.unload("hermes-tern")
    assert _legacy_call(server, peer, "hermes-tern.plan.status",
                        session_id="live")["error"]["code"] in (4001, -32601)


@pytest.mark.asyncio
async def test_canonical_real_authority_dispatch_requires_attached_operator(tmp_path, monkeypatch):
    from gateway.session_authority import LiveSession, SessionAuthority
    from hermes_cli import plugins
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch
    from tui_gateway.ws import _authority_connection, _dispatch_request

    home = tmp_path / "canonical-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    plugins._reset_plugin_managers_for_tests()
    monkeypatch.setattr(plugins, "discover_plugins", lambda force=False: None)
    manager = plugins.get_plugin_manager()
    plan_gateway.register(plugins.PluginContext(
        plugins.PluginManifest(name="hermes-tern"), manager))
    db = SessionDB(db_path=home / "state.db")
    try:
        db.create_session("persisted", source="test")
        runner = SimpleNamespace(_draining=False,
                                 config=SimpleNamespace(multiplex_profiles=False))
        authority = SessionAuthority(
            runner, profile_id=str(home), instance_id="instance",
            db=db, epoch=begin_runtime_epoch(db, instance_id="instance"))
        authority.sessions["persisted"] = LiveSession(None, "active-route")

        def connect(*, operator=True, subject="operator"):
            transport = SimpleNamespace(closed=False, frames=[], write=lambda frame: True)
            identity = {
                "user_id": subject, "provider": "local", "native_bootstrap": True,
                "profile_id": authority.profile_id, "instance_id": authority.instance_id,
            }
            return _authority_connection(
                SimpleNamespace(scope={"hermes.session_authority": authority}),
                transport, identity, operator=operator)

        async def call(peer, verb, params=None):
            return await _dispatch_request(
                peer, {"jsonrpc": "2.0", "id": 3, "method": verb, "params": params or {}},
                verb, peer.transport)

        a, b = connect(), connect(subject="second")
        reader = connect(operator=False, subject="reader")
        try:
            assert (await call(a, "hermes-tern.plan.status",
                               {"session_id": "persisted"}))["error"]["code"] == 4001
            for peer in (a, b):
                attached = await call(peer, "session.resume", {"session_id": "persisted"})
                assert "result" in attached, attached
                result = await call(peer, "hermes-tern.plan.status",
                                    {"session_id": "persisted"})
                assert result["result"]["supported"] is False, result
                rejected = await call(peer, "hermes-tern.plan.decide", {
                    "session_id": "persisted", "plan_id": "fabricated", "revision": 1,
                    "intent": "approve",
                })
                assert rejected["error"]["code"] == 4094, rejected
            assert (await call(reader, "hermes-tern.plan.status",
                               {"session_id": "persisted"}))["error"]["code"] == 4001
            # No invented approved revision or executable user-turn context.
        finally:
            await asyncio.gather(a.close(), b.close(), reader.close())
    finally:
        db.close()
        plugins._reset_plugin_managers_for_tests()
