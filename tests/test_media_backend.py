"""Production registered legacy/canonical image RPC coverage, no fake dispatcher."""
from __future__ import annotations

import asyncio
import base64
import os
import queue
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import plugins
from hermes_state import SessionDB
from hermes_tern_plugin import media_backend as media

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVmQAAAAASUVORK5CYII="
)


def install():
    manager = plugins.get_plugin_manager()
    ctx = plugins.PluginContext(plugins.PluginManifest(name="hermes-tern"), manager)
    media.register(ctx)
    return manager


def durable_user_image(db, stored, path, *, image_bytes=PNG, with_bytes=True):
    parts = [{"type": "text", "text": f"Description\n@image:{path}"}]
    if with_bytes:
        parts.append({"type": "image_url", "image_url": {
            "url": "data:image/png;base64," + base64.b64encode(image_bytes).decode()}})
    db.append_message(stored, "user", parts)


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
        return self.frames.get(timeout=10)


@pytest.fixture
def legacy(tmp_path, monkeypatch):
    from tui_gateway import server

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(server, "_hermes_home", home)
    monkeypatch.setattr(server, "_sessions", {})
    plugins._reset_plugin_managers_for_tests()
    monkeypatch.setattr(plugins, "discover_plugins", lambda force=False: None)
    manager = install()
    db = SessionDB(db_path=home / "state.db")
    db.create_session("durable-alice", source="test")
    db.create_session("durable-bob", source="test")
    alice, bob = Peer(), Peer()
    server._sessions["live-alice"] = {
        "session_key": "durable-alice", "profile_home": str(home),
        "transport": alice, "history": [], "history_lock": threading.Lock(), "running": False,
    }
    server._sessions["live-bob"] = {
        "session_key": "durable-bob", "profile_home": str(home),
        "transport": bob, "history": [], "history_lock": threading.Lock(), "running": False,
    }

    def call(peer, method, *, sid, **params):
        frame = {"jsonrpc": "2.0", "id": 10, "method": method,
                 "params": {"session_id": sid, **params}}
        reply = server.dispatch(frame, peer)
        return peer.receive() if reply is None else reply

    yield SimpleNamespace(home=home, db=db, server=server, manager=manager,
                          alice=alice, bob=bob, call=call)
    db.close()
    plugins._reset_plugin_managers_for_tests()


def test_real_legacy_dispatch_uses_different_live_and_stored_id_and_resumes(legacy):
    image = legacy.home / "images" / "persisted.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(PNG)
    ask = lambda peer, sid="live-alice": legacy.call(
        peer, media.IMAGE_METHOD, sid=sid, path=str(image), mime="image/png")
    # A forged @image line alone, even from this account, has no server-side byte provenance.
    durable_user_image(legacy.db, "durable-alice", image, with_bytes=False)
    assert ask(legacy.alice)["error"]["code"] == 4016
    durable_user_image(legacy.db, "durable-alice", image)
    assert ask(legacy.alice)["result"] == {
        "content_base64": base64.b64encode(PNG).decode(),
        "mime": "image/png", "bytes": len(PNG),
    }
    # The distinct durable key, not a live SID or viewer/cwd hint, survives reattachment.
    original = legacy.server._sessions.pop("live-alice")
    legacy.server._sessions["live-resumed"] = original
    assert ask(legacy.alice, "live-alice")["error"]["code"] == 4001
    assert ask(legacy.alice, "live-resumed")["result"]["bytes"] == len(PNG)
    assert ask(legacy.bob, "live-resumed")["error"]["code"] == 4001


def test_real_legacy_rejects_cross_session_profile_path_and_tool_claims(legacy):
    image = legacy.home / "images" / "same.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(PNG)
    durable_user_image(legacy.db, "durable-alice", image)
    call = legacy.call
    assert call(legacy.bob, media.IMAGE_METHOD, sid="live-bob", path=str(image))["error"]["code"] == 4016
    assert call(legacy.alice, media.IMAGE_METHOD, sid="live-alice",
                path=str(image), tool_call_id="read-1")["error"]["code"] == 4016
    assert call(legacy.alice, media.IMAGE_METHOD, sid="live-alice",
                path=str(image), mime="image/jpeg")["error"]["code"] == 4016
    assert call(legacy.alice, media.IMAGE_METHOD, sid="live-alice",
                path=str(image), profile="another")["error"]["code"] == 4001
    assert call(legacy.alice, media.IMAGE_METHOD, sid="live-alice",
                path=str(legacy.home / "secret.png"))["error"]["code"] == 4016
    # Never stage canonical-style plugin bytes without legacy image.attach_bytes queuing.
    assert call(legacy.alice, media.ATTACH_METHOD, sid="live-alice",
                filename="a.png", content_base64=base64.b64encode(PNG).decode())["error"]["code"] == 4016


def test_legacy_file_nonregular_removed_oversized_and_mismatched_magic(legacy):
    image = legacy.home / "images" / "bounded.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(PNG)
    durable_user_image(legacy.db, "durable-alice", image)
    read = lambda: legacy.call(legacy.alice, media.IMAGE_METHOD, sid="live-alice", path=str(image))
    assert read()["result"]["mime"] == "image/png"
    image.unlink()
    assert read()["error"]["code"] == 4016
    image.symlink_to(legacy.home / "state.db")
    assert read()["error"]["code"] == 4016
    image.unlink()
    image.mkdir()
    assert read()["error"]["code"] == 4016
    image.rmdir()
    if hasattr(os, "mkfifo"):
        os.mkfifo(image)
        assert read()["error"]["code"] == 4016
        image.unlink()
    with image.open("wb") as stream:
        stream.truncate(media.PREVIEW_MAX_BYTES + 1)
    assert read()["error"]["code"] == 4016
    image.write_bytes(b"not a raster")
    assert read()["error"]["code"] == 4016
    image.write_bytes(PNG)
    assert read()["result"]["bytes"] == len(PNG)


class NativeTransport:
    def __init__(self):
        self.frames = []
        self.closed = False

    def write(self, frame):
        if self.closed:
            return False
        self.frames.append(frame)
        return True


@pytest.fixture
def native(tmp_path, monkeypatch):
    from gateway.session_authority import LiveSession, SessionAuthority
    from hermes_state_runtime import begin_runtime_epoch

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    plugins._reset_plugin_managers_for_tests()
    monkeypatch.setattr(plugins, "discover_plugins", lambda force=False: None)
    manager = install()
    db = SessionDB(db_path=home / "state.db")
    for sid in ("owned", "foreign"):
        db.create_session(sid, source="test")
    runner = SimpleNamespace(_draining=False, config=SimpleNamespace(multiplex_profiles=False))
    authority = SessionAuthority(runner, profile_id=str(home), instance_id="instance", db=db,
                                 epoch=begin_runtime_epoch(db, instance_id="instance"))
    authority.sessions["owned"] = LiveSession(None, "route-owned")
    authority.sessions["foreign"] = LiveSession(None, "route-foreign")
    yield SimpleNamespace(authority=authority, db=db, manager=manager, home=home)
    db.close()
    plugins._reset_plugin_managers_for_tests()


def connect(authority):
    from tui_gateway.ws import _authority_connection
    identity = {"user_id": "test", "provider": "local", "native_bootstrap": True,
                "profile_id": authority.profile_id, "instance_id": authority.instance_id}
    return _authority_connection(
        SimpleNamespace(scope={"hermes.session_authority": authority}),
        NativeTransport(), identity, operator=True)


async def rpc(connection, method, params=None):
    from tui_gateway.ws import _dispatch_request
    return await _dispatch_request(connection, {"jsonrpc": "2.0", "id": 15,
        "method": method, "params": params or {}}, method, connection.transport)


async def resume(connection, sid="owned"):
    answer = await rpc(connection, "session.resume", {"session_id": sid})
    assert "result" in answer, answer
    return answer["result"]["subscription_id"]


async def staged(connection, sid="owned", content=PNG):
    return await rpc(connection, media.ATTACH_METHOD, {
        "session_id": sid, "filename": "wrong.jpg",
        "content_base64": base64.b64encode(content).decode(),
    })


async def preview(connection, path, sid="owned", **params):
    return await rpc(connection, media.IMAGE_METHOD, {
        "session_id": sid, "path": path, **params,
    })


@pytest.mark.asyncio
async def test_canonical_registered_dispatch_pending_caller_and_persisted_resume(native):
    viewer, different = connect(native.authority), connect(native.authority)
    try:
        token = await resume(viewer)
        await resume(different)
        await resume(viewer, "foreign")
        methods = (await rpc(viewer, "gateway.capabilities", {"session_id": "owned"}))["result"]["plugin_methods"]
        assert media.IMAGE_METHOD in methods and media.ATTACH_METHOD in methods
        uploaded = await staged(viewer)
        assert "result" in uploaded, uploaded
        path = uploaded["result"]["path"]
        assert path.startswith(str(native.home / "cache" / "images"))
        assert path.endswith(".png")  # bytes win over the claimed .jpg filename
        answer = await preview(viewer, path, mime="image/png")
        assert answer["result"]["content_base64"] == base64.b64encode(PNG).decode()
        assert (await preview(different, path))["error"]["code"] == 4016
        assert (await preview(viewer, path, sid="foreign"))["error"]["code"] == 4016
        assert (await preview(viewer, path, tool_call_id="read-1"))["error"]["code"] == 4016
        assert (await preview(viewer, path, mime="image/jpeg"))["error"]["code"] == 4016
        assert (await rpc(viewer, "session.detach", {
            "session_id": "owned", "subscription_id": token}))["result"]["detached"] is True
        assert (await preview(viewer, path))["error"]["code"] == 4001
        await resume(viewer)
        assert (await preview(viewer, path))["error"]["code"] == 4016
        durable_user_image(native.db, "owned", path)
        assert (await preview(viewer, path))["result"]["mime"] == "image/png"
    finally:
        await viewer.close()
        await different.close()


@pytest.mark.asyncio
async def test_canonical_stale_source_after_read_unload_and_strict_params(native, monkeypatch):
    viewer = connect(native.authority)
    try:
        await resume(viewer)
        uploaded = await staged(viewer)
        path = uploaded["result"]["path"]
        assert (await preview(viewer, path, extra="forbidden"))["error"]["code"] == -32602
        assert (await preview(viewer, path, mime="image/jpeg"))["error"]["code"] == 4016
        huge = await staged(viewer, content=PNG + b"\x00" * (media.STAGING_MAX_BYTES + 1))
        assert huge["error"]["code"] == 4016
        original = media._read_regular

        def disappear(source, root):
            value = original(source, root)
            source.unlink()
            return value

        monkeypatch.setattr(media, "_read_regular", disappear)
        assert (await preview(viewer, path))["error"]["code"] == 4016
        monkeypatch.setattr(media, "_read_regular", original)
        assert native.manager.unload("hermes-tern")
        assert (await preview(viewer, path))["error"]["code"] == -32601
    finally:
        await viewer.close()


@pytest.mark.asyncio
async def test_canonical_removed_and_replaced_source_and_generation(native):
    viewer = connect(native.authority)
    try:
        await resume(viewer)
        uploaded = await staged(viewer)
        path = Path(uploaded["result"]["path"])
        path.unlink()
        path.symlink_to(native.home / "state.db")
        assert (await preview(viewer, str(path)))["error"]["code"] == 4016
        path.unlink()
        path.write_bytes(PNG)
        # Even identical replacement bytes cannot inherit the original stage inode.
        assert (await preview(viewer, str(path)))["error"]["code"] == 4016
    finally:
        await viewer.close()
