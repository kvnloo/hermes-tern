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


def flush_real_user(db, stored, path, *, image_bytes=PNG, with_bytes=True):
    """Run the actual session-persistence flush and reload, not a synthetic row."""
    from agent.session_persistence import SessionPersistenceMixin

    class Writer(SessionPersistenceMixin):
        def __init__(self):
            self.session_id = stored
            self._session_db = db
            self._session_db_created = True
            self._last_flushed_db_idx = 0

    prompt = f"Actual prompt\n@image:{path}"
    content = prompt if not with_bytes else [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {
            "url": "data:image/png;base64," + base64.b64encode(image_bytes).decode("ascii")}},
    ]
    assert Writer()._flush_messages_to_session_db([{"role": "user", "content": content}]) is True
    rows = db.get_messages_as_conversation(stored, include_ancestors=True)
    assert rows and isinstance(rows[-1]["content"], str)
    assert "@image:" in rows[-1]["content"]
    assert "data:image/png;base64" not in rows[-1]["content"]
    return rows[-1]


def committed_attachment(db, stored, path, *, epoch, request_id="image-1", outcome="completed"):
    """Core image admission, immutable capture, claim, and terminal settlement."""
    from gateway.session_ingress_media import admit_attachments, capture_lease
    from hermes_state_runtime import admit_session_input, claim_session_input, settle_session_input

    with capture_lease():
        fields = admit_attachments([{"path": str(path), "mime": "image/png"}])
        queued = admit_session_input(
            db, epoch=epoch, principal_id="local-test", session_id=stored,
            request_id=request_id, payload={"text": "Actual prompt", **fields})
        assert queued["status"] == "queued"
        running = claim_session_input(db, epoch=epoch, session_id=stored)
        assert running is not None and running["status"] == "started"
        settled = settle_session_input(
            db, epoch=epoch, admission_id=running["admission_id"],
            generation=running["generation"], outcome=outcome)
        assert settled["status"] == "terminal"
        return settled

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


def test_real_legacy_cannot_invent_durable_authority_from_a_live_sid(legacy):
    image = legacy.home / "images" / "persisted.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(PNG)
    read = lambda peer, sid="live-alice": legacy.call(
        peer, media.IMAGE_METHOD, sid=sid, path=str(image), mime="image/png")
    flush_real_user(legacy.db, "durable-alice", image)
    # The core writer projects inline images to text and the public legacy
    # GatewayRequestContext has no authenticated live->durable key mapping.
    assert read(legacy.alice)["error"]["code"] == 4016
    owned = legacy.server._sessions.pop("live-alice")
    legacy.server._sessions["live-resumed"] = owned
    assert read(legacy.alice, "live-alice")["error"]["code"] == 4001
    assert read(legacy.alice, "live-resumed")["error"]["code"] == 4016
    assert read(legacy.bob, "live-resumed")["error"]["code"] == 4001

def test_real_legacy_rejects_cross_session_profile_path_and_tool_claims(legacy):
    image = legacy.home / "images" / "same.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(PNG)
    flush_real_user(legacy.db, "durable-alice", image)
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
    flush_real_user(legacy.db, "durable-alice", image)
    read = lambda: legacy.call(legacy.alice, media.IMAGE_METHOD, sid="live-alice", path=str(image))
    assert read()["error"]["code"] == 4016
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
    assert read()["error"]["code"] == 4016


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
        flush_real_user(native.db, "owned", path)
        assert (await preview(viewer, path))["error"]["code"] == 4016
        committed_attachment(native.db, "owned", path, epoch=native.authority.epoch)
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


@pytest.mark.asyncio
async def test_durable_image_needs_real_stage_and_successful_owned_admission(native):
    viewer, other = connect(native.authority), connect(native.authority)
    try:
        token = await resume(viewer)
        await resume(other, "foreign")
        upload = await staged(viewer)
        assert "result" in upload, upload
        path = upload["result"]["path"]
        flush_real_user(native.db, "owned", path, with_bytes=False)
        await rpc(viewer, "session.detach", {
            "session_id": "owned", "subscription_id": token})
        await resume(viewer)
        assert (await preview(viewer, path))["error"]["code"] == 4016

        # Actual persisted user text plus failed work still has no authority.
        committed_attachment(native.db, "owned", path, epoch=native.authority.epoch,
                             request_id="failed-1", outcome="failed")
        assert (await preview(viewer, path))["error"]["code"] == 4016
        assert (await preview(other, path, sid="foreign"))["error"]["code"] == 4016

        # A second real core stage lacks the plugin-owned upload witness even
        # when its bytes match another session-owned terminal admission.
        from tui_gateway.prompt_attachments import stage_image_bytes
        from gateway.platforms.base import get_image_cache_dir
        unproven = stage_image_bytes(get_image_cache_dir(), PNG, ".png", prefix="unproven")
        flush_real_user(native.db, "owned", unproven, with_bytes=False)
        committed_attachment(native.db, "owned", path, epoch=native.authority.epoch,
                             request_id="success-2")
        assert (await preview(viewer, str(unproven)))["error"]["code"] == 4016
        assert (await preview(viewer, path))["result"]["bytes"] == len(PNG)
        assert (await preview(other, path, sid="foreign"))["error"]["code"] == 4016
    finally:
        await viewer.close()
        await other.close()


def test_real_staging_helper_accepts_home_alias_but_rejects_children_links(tmp_path, monkeypatch):
    from gateway.platforms.base import get_image_cache_dir
    from tui_gateway.prompt_attachments import stage_image_bytes

    real_home = tmp_path / "profiles" / "primary"
    real_home.mkdir(parents=True)
    alias = tmp_path / "home-alias"
    alias.symlink_to(real_home, target_is_directory=True)
    monkeypatch.setenv("HERMES_HOME", str(alias))
    directory = get_image_cache_dir()
    image = stage_image_bytes(directory, PNG, ".png", prefix="actual_core")
    owner = media._Owner(real_home, alias, "primary", "owned", False)
    assert directory in media._roots(owner)
    assert media._read_regular(image, directory)[0] == PNG
    # Normal nested cache/image directories must remain strictly regular.
    linked_leaf = directory / "linked.png"
    linked_leaf.symlink_to(image)
    with pytest.raises((OSError, ValueError)):
        media._read_regular(linked_leaf, directory)
    linked_leaf.unlink()

    outside = tmp_path / "outside"
    (outside / "images").mkdir(parents=True)
    (outside / "images" / "external.png").write_bytes(PNG)
    # Plant the malicious link below the legitimate configured HOME, not
    # elsewhere. A Path.resolve-based authorization would accept this.
    original_cache = real_home / "cache"
    original_cache.rename(real_home / "cache-original")
    original_cache.symlink_to(outside, target_is_directory=True)
    with pytest.raises(OSError):
        media._read_regular(alias / "cache" / "images" / "external.png",
                            alias / "cache" / "images")

    sibling = tmp_path / "profiles" / "sibling" / "cache" / "images"
    sibling.mkdir(parents=True)
    with pytest.raises(Exception, match="Image root is not inside"):
        media._root_parts(sibling)


@pytest.mark.asyncio
async def test_canonical_rejects_sibling_profile_and_traversal(native):
    viewer = connect(native.authority)
    try:
        await resume(viewer)
        staged_result = await staged(viewer)
        good = staged_result["result"]["path"]
        sibling = native.home.parent / "other-profile" / "cache" / "images"
        sibling.mkdir(parents=True)
        (sibling / "picture.png").write_bytes(PNG)
        assert (await preview(viewer, str(sibling / "picture.png")))["error"]["code"] == 4016
        assert (await preview(viewer, str(Path(good).parent / ".." / "images" / "picture.png")))["error"]["code"] == 4016
        assert (await preview(viewer, good, tool_call_id="typed-call-id"))["error"]["code"] == 4016
    finally:
        await viewer.close()
