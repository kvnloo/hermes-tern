"""Real ba42 canonical PluginContext/registry/WS dispatch, without live I/O.

OMP runs this against the exact green Hermes core. The temporary plugin wrapper
calls this module's real register(ctx); it does not imitate a method registry.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from openai import OpenAI

from hermes_tern_plugin import table_chart_gateway as charts

TABLE = "| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |"


class Transport:
    def __init__(self):
        self.closed = False
        self.frames = []

    def write(self, frame):
        if self.closed:
            return False
        self.frames.append(frame)
        return True


@pytest.fixture
def native(tmp_path, monkeypatch):
    from hermes_cli import plugins
    from gateway.session_authority import LiveSession, SessionAuthority
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    plugins._reset_plugin_managers_for_tests()
    monkeypatch.setattr(plugins, "discover_plugins", lambda force=False: None)
    monkeypatch.setattr(plugins, "get_bundled_plugins_dir", lambda: tmp_path / "empty")
    monkeypatch.setattr(plugins.PluginManager, "_scan_entry_points", lambda self: [])

    plugin = home / "plugins" / "hermes-tern"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text(
        "name: hermes-tern\nversion: 1.0.0\ndescription: Table gateway fixture\n",
        encoding="utf-8",
    )
    (plugin / "__init__.py").write_text(
        "from hermes_tern_plugin.table_chart_gateway import register\n",
        encoding="utf-8",
    )
    (home / "config.yaml").write_text(
        'plugins:\n  enabled: [hermes-tern]\n', encoding="utf-8",
    )
    settings = home / "hermes-tern" / "settings.json"
    settings.parent.mkdir()
    settings.write_text('{"tableCharts":"smart"}\n', encoding="utf-8")
    manager = plugins.get_plugin_manager()
    manager.discover_and_load()
    assert manager._plugins["hermes-tern"].enabled
    assert sorted(manager._gateway_methods) == [charts.PLAN_METHOD, charts.POLICY_METHOD]

    db = SessionDB(db_path=home / "state.db")
    db.create_session("owned", source="test")
    db.create_session("foreign", source="test")
    runner = SimpleNamespace(_draining=False, config=SimpleNamespace(multiplex_profiles=False))
    authority = SessionAuthority(
        runner, profile_id=str(home), instance_id="instance", db=db,
        epoch=begin_runtime_epoch(db, instance_id="instance"),
    )
    authority.sessions["owned"] = LiveSession(None, "owned-route")
    authority.sessions["foreign"] = LiveSession(None, "foreign-route")
    yield SimpleNamespace(home=home, manager=manager, settings=settings, authority=authority)
    db.close()
    plugins._reset_plugin_managers_for_tests()


def connect(authority, *, subject="human", capabilities=None):
    from tui_gateway.ws import _authority_connection

    identity = {
        "user_id": subject, "provider": "local", "native_bootstrap": True,
        "profile_id": authority.profile_id, "instance_id": authority.instance_id,
    }
    if capabilities is not None:
        identity["capabilities"] = capabilities
    return _authority_connection(
        SimpleNamespace(scope={"hermes.session_authority": authority}),
        Transport(), identity, operator=True,
    )


async def rpc(connection, method, params=None):
    from tui_gateway.ws import _dispatch_request

    frame = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return await _dispatch_request(connection, frame, method, connection.transport)


async def resume(connection, sid="owned"):
    reply = await rpc(connection, "session.resume", {"session_id": sid})
    assert "result" in reply, reply
    return reply["result"]["subscription_id"]


async def entered(event):
    for _ in range(400):
        if event.is_set():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("fixture transport never entered")


@pytest.fixture
def network(monkeypatch):
    from agent import auxiliary_client, redact

    calls: list[dict] = []
    status = {"code": 200, "kind": "line", "block": None, "entered": None}

    def exchange(request):
        calls.append(json.loads(request.content))
        if status["entered"] is not None:
            status["entered"].set()
        if status["block"] is not None:
            status["block"].wait(10)
        if status["code"] != 200:
            return httpx.Response(status["code"], json={
                "error": {"type": "invalid_request_error", "message": "fixture error"}
            })
        return httpx.Response(200, json={
            "id": "local", "object": "chat.completion", "created": 1,
            "model": "fixture-model", "choices": [{
                "index": 0, "finish_reason": "stop",
                "message": {"role": "assistant", "content": status["kind"]},
            }],
        })

    client = OpenAI(
        api_key="local-fixture", base_url="https://fixture.invalid/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(exchange)),
        max_retries=2,
    )
    monkeypatch.setattr(auxiliary_client, "get_text_auxiliary_client",
                        lambda task: (client, "fixture-model") if task == "table_charts" else (None, None))
    monkeypatch.setattr(redact, "redact_sensitive_text",
                        lambda text, *, force=False: text if force else (_ for _ in ()).throw(AssertionError()))
    return status, calls


@pytest.mark.asyncio
async def test_actual_namespace_discovery_policy_and_strict_deny(native, network):
    status, calls = network
    client = connect(native.authority)
    foreign = connect(native.authority, subject="foreign")
    read_only = connect(native.authority, subject="reader", capabilities=["session:read"])
    try:
        assert (await rpc(client, "gateway.capabilities"))["result"]["plugin_methods"] == []
        assert (await rpc(client, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))["error"]["code"] == 4001

        await resume(client)
        await resume(foreign, "foreign")
        await resume(read_only)
        names = (await rpc(client, "gateway.capabilities", {
            "session_id": "owned",
        }))["result"]["plugin_methods"]
        assert names == [charts.PLAN_METHOD, charts.POLICY_METHOD]
        assert (await rpc(client, charts.POLICY_METHOD, {
            "session_id": "owned",
        }))["result"] == {"mode": "smart"}

        for viewer, params in (
            (client, {"session_id": "foreign", "source": TABLE}),
            (foreign, {"session_id": "owned", "source": TABLE}),
            (read_only, {"session_id": "owned", "source": TABLE}),
            (client, {"session_id": "owned", "source": TABLE, "profile": "default"}),
        ):
            assert (await rpc(viewer, charts.PLAN_METHOD, params))["error"]["code"] == 4001
        for bad in (
            {"session_id": "owned", "source": TABLE, "extra": "no"},
            {"session_id": "owned", "source": 7},
            {"session_id": 7, "source": TABLE},
        ):
            assert (await rpc(client, charts.PLAN_METHOD, bad))["error"]["code"] == -32602
        assert calls == []
        assert (await rpc(client, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))["result"] == {"kind": "line"}
        assert len(calls) == 1
        assert calls[0].get("max_tokens", calls[0].get("max_completion_tokens")) == 64
    finally:
        await client.close()
        await foreign.close()
        await read_only.close()


@pytest.mark.asyncio
async def test_owner_settings_off_always_never_send(native, network):
    _status, calls = network
    viewer = connect(native.authority)
    try:
        await resume(viewer)
        for mode in ("off", "always"):
            native.settings.write_text(json.dumps({"tableCharts": mode}))
            assert (await rpc(viewer, charts.POLICY_METHOD, {
                "session_id": "owned",
            }))["result"] == {"mode": mode}
            assert (await rpc(viewer, charts.PLAN_METHOD, {
                "session_id": "owned", "source": TABLE,
            }))["result"] == {"kind": "bar"}
        assert calls == []
    finally:
        await viewer.close()


@pytest.mark.asyncio
async def test_two_connections_share_one_flight_and_eight_sends_across_reconnect(native, network):
    status, calls = network
    first = connect(native.authority)
    second = connect(native.authority, subject="second")
    release = threading.Event()
    mark = threading.Event()
    try:
        await resume(first)
        await resume(second)
        status["block"], status["entered"] = release, mark
        running = asyncio.create_task(rpc(first, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))
        await entered(mark)
        assert len(calls) == 1
        assert (await rpc(second, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))["result"] == {"kind": "bar"}
        assert len(calls) == 1
        release.set()
        assert (await running)["result"] == {"kind": "line"}
        status["block"], status["entered"] = None, None
        for _ in range(7):
            assert (await rpc(second, charts.PLAN_METHOD, {
                "session_id": "owned", "source": TABLE,
            }))["result"] == {"kind": "line"}
        assert len(calls) == 8
        await first.close()
        again = connect(native.authority, subject="reconnected")
        try:
            await resume(again)
            assert (await rpc(again, charts.PLAN_METHOD, {
                "session_id": "owned", "source": TABLE,
            }))["result"] == {"kind": "bar"}
            assert len(calls) == 8
        finally:
            await again.close()
    finally:
        release.set()
        await first.close()
        await second.close()


@pytest.mark.asyncio
async def test_provider_errors_never_retry_or_strip_cap(native, network):
    status, calls = network
    viewer = connect(native.authority)
    try:
        await resume(viewer)
        for code in (400, 401, 402, 408, 429, 500, 503):
            status["code"] = code
            assert (await rpc(viewer, charts.PLAN_METHOD, {
                "session_id": "owned", "source": TABLE,
            }))["result"] == {"kind": "bar"}
        assert len(calls) == 7
        assert all(payload.get("max_tokens", payload.get("max_completion_tokens")) == 64
                   for payload in calls)
    finally:
        await viewer.close()


@pytest.mark.asyncio
async def test_timeout_keeps_provider_charged_until_actual_settlement(native, network):
    status, calls = network
    viewer = connect(native.authority)
    release = threading.Event()
    entered_wire = threading.Event()
    status["block"], status["entered"] = release, entered_wire
    try:
        await resume(viewer)
        running = asyncio.create_task(rpc(viewer, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))
        await entered(entered_wire)
        before = time.monotonic()
        reply = await running
        assert reply["result"] == {"kind": "bar"}
        assert time.monotonic() - before <= 5.75
        assert len(calls) == 1
        assert (await rpc(viewer, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))["result"] == {"kind": "bar"}
        assert len(calls) == 1
    finally:
        release.set()
        await viewer.close()


@pytest.mark.asyncio
async def test_unload_disposes_real_registry_and_rejects_old_results(native, network):
    status, calls = network
    viewer = connect(native.authority)
    release = threading.Event()
    mark = threading.Event()
    status["block"], status["entered"] = release, mark
    try:
        await resume(viewer)
        running = asyncio.create_task(rpc(viewer, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))
        await entered(mark)
        assert native.manager.unload("hermes-tern")
        assert (await rpc(viewer, "gateway.capabilities", {
            "session_id": "owned",
        }))["result"]["plugin_methods"] == []
        assert (await rpc(viewer, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))["error"]["code"] == -32601
        release.set()
        stale = await running
        assert "error" in stale or stale.get("result") == {"kind": "bar"}
        assert len(calls) == 1
    finally:
        release.set()
        await viewer.close()


@pytest.mark.asyncio
async def test_missing_provider_is_explicitly_unsupported(native, network, monkeypatch):
    from agent import auxiliary_client

    _status, calls = network
    monkeypatch.setattr(auxiliary_client, "get_text_auxiliary_client",
                        lambda task: (None, None))
    viewer = connect(native.authority)
    try:
        await resume(viewer)
        reply = await rpc(viewer, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        })
        assert reply["result"] == {
            "status": "unsupported", "reason": "table_provider_unavailable",
        }
        assert calls == []
    finally:
        await viewer.close()


@pytest.mark.asyncio
async def test_detach_reattach_does_not_publish_stale_provider_result(native, network):
    status, calls = network
    viewer = connect(native.authority)
    release = threading.Event()
    seen = threading.Event()
    status["block"], status["entered"] = release, seen
    try:
        token = await resume(viewer)
        pending = asyncio.create_task(rpc(viewer, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))
        await entered(seen)
        detached = await rpc(viewer, "session.detach", {
            "session_id": "owned", "subscription_id": token,
        })
        assert detached["result"]["detached"] is True
        await resume(viewer)  # Same visible ID is NOT original request authority.
        blocked = await rpc(viewer, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        })
        assert blocked["result"] == {"kind": "bar"}
        assert len(calls) == 1
        release.set()
        assert (await pending)["error"]["code"] == 4001
    finally:
        release.set()
        await viewer.close()


@pytest.mark.asyncio
async def test_inflight_policy_change_cannot_apply_old_result(native, network):
    status, calls = network
    viewer = connect(native.authority)
    release = threading.Event()
    seen = threading.Event()
    status["block"], status["entered"] = release, seen
    try:
        await resume(viewer)
        pending = asyncio.create_task(rpc(viewer, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))
        await entered(seen)
        native.settings.write_text('{"tableCharts":"off"}')
        release.set()
        assert (await pending)["result"] == {"kind": "bar"}
        assert len(calls) == 1
        assert (await rpc(viewer, charts.POLICY_METHOD, {
            "session_id": "owned",
        }))["result"] == {"mode": "off"}
    finally:
        release.set()
        await viewer.close()


@pytest.mark.asyncio
async def test_replaced_live_session_refuses_old_provider_result(native, network):
    from gateway.session_authority import LiveSession

    status, calls = network
    viewer = connect(native.authority)
    release = threading.Event()
    seen = threading.Event()
    status["block"], status["entered"] = release, seen
    try:
        await resume(viewer)
        pending = asyncio.create_task(rpc(viewer, charts.PLAN_METHOD, {
            "session_id": "owned", "source": TABLE,
        }))
        await entered(seen)
        native.authority.sessions["owned"] = LiveSession(None, "replaced-route")
        release.set()
        assert (await pending)["error"]["code"] == 4001
        assert len(calls) == 1
    finally:
        release.set()
        await viewer.close()
