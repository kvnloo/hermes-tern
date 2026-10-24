"""Production registered legacy/canonical image RPC coverage, no fake dispatcher."""
from __future__ import annotations

import asyncio
import base64
import io
import os
import shutil
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


def flush_user(db, stored, content):
    """The real SessionPersistence writer, then an independent read-only reload."""
    from agent.session_persistence import SessionPersistenceMixin

    class Writer(SessionPersistenceMixin):
        def __init__(self):
            self.session_id = stored
            self._session_db = db
            self._session_db_created = True
            self._last_flushed_db_idx = 0

    assert Writer()._flush_messages_to_session_db([{"role": "user", "content": content}]) is True
    reloaded = SessionDB(db_path=db.db_path, read_only=True)
    try:
        rows = reloaded.get_messages_as_conversation(stored, include_ancestors=True)
        assert rows and isinstance(rows[-1]["content"], str)
        assert "data:image/" not in rows[-1]["content"]
        return rows[-1]
    finally:
        reloaded.close()


def flush_typed_user(db, stored, path):
    """Negative control: arbitrary original-staging @image text is NOT core media."""
    return flush_user(db, stored, f"Actual prompt\n@image:{path}")


def flush_committed_user(db, stored, admission):
    """REAL core restore → image_routing builder → durable flush → fresh reload."""
    from agent.image_routing import build_native_content_parts
    from gateway.session_ingress_media import restore_attachments

    restored = restore_attachments(admission["payload"])
    (committed,) = restored["media_urls"]
    parts, skipped = build_native_content_parts(admission["payload"]["text"], restored["media_urls"])
    assert skipped == []
    assert len(parts) == 2 and parts[0]["type"] == "text" and parts[1]["type"] == "image_url"
    assert parts[1]["image_url"]["url"].startswith("data:image/")
    marker = f"[Image attached at: {committed}]"
    assert marker in parts[0]["text"].splitlines()
    stored_row = flush_user(db, stored, parts)
    assert marker in stored_row["content"].splitlines()
    assert "[screenshot]" in stored_row["content"]
    return committed


async def admit_canonical(viewer, db, stage, *, sid="owned", mime="image/png", request_id="real-1"):
    """Only the public authenticated canonical prompt.submit makes a receipt."""
    from hermes_state_runtime import get_session_admission

    response = await rpc(viewer, "prompt.submit", {
        "session_id": sid, "submission_id": request_id, "text": "Actual prompt",
        "attachments": [{"path": str(stage), "mime": mime}],
    })
    assert "result" in response, response
    row = get_session_admission(db, admission_id=response["result"]["admission_id"])
    assert row is not None and row["status"] == "queued"
    assert row["target_session_id"] == sid and row["payload"]["text"] == "Actual prompt"
    return row


def settle_core(db, sid, epoch, *, outcome="completed"):
    from hermes_state_runtime import claim_session_input, settle_session_input

    started = claim_session_input(db, epoch=epoch, session_id=sid)
    assert started is not None and started["status"] == "started"
    terminal = settle_session_input(
        db, epoch=epoch, admission_id=started["admission_id"],
        generation=started["generation"], outcome=outcome,
    )
    assert terminal["status"] == "terminal" and terminal["outcome"] == outcome
    return terminal


def jpeg_bytes():
    """A genuine JPEG, not an invalid magic-only payload."""
    from PIL import Image

    image = Image.new("RGB", (1, 1), (16, 32, 48))
    out = io.BytesIO()
    image.save(out, format="JPEG")
    return out.getvalue()

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
    flush_typed_user(legacy.db, "durable-alice", image)
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
    flush_typed_user(legacy.db, "durable-alice", image)
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
    flush_typed_user(legacy.db, "durable-alice", image)
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
@pytest.mark.parametrize("mime,payload", [("image/png", PNG), ("image/jpeg", None)])
async def test_canonical_registered_dispatch_pending_caller_and_persisted_resume(
    native, monkeypatch, mime, payload,
):
    viewer, different = connect(native.authority), connect(native.authority)
    try:
        token = await resume(viewer)
        await resume(different)
        await resume(viewer, "foreign")
        methods = (await rpc(viewer, "gateway.capabilities", {"session_id": "owned"}))["result"]["plugin_methods"]
        assert media.IMAGE_METHOD in methods and media.ATTACH_METHOD in methods
        content = payload if payload is not None else jpeg_bytes()
        uploaded = await staged(viewer, content=content)
        assert "result" in uploaded, uploaded
        stage = uploaded["result"]["path"]
        assert stage.startswith(str(native.home / "cache" / "images"))
        assert stage.endswith(".png" if mime == "image/png" else ".jpg")
        assert (await preview(viewer, stage, mime=mime))["result"]["content_base64"] == base64.b64encode(content).decode()
        assert (await preview(different, stage))["error"]["code"] == 4016
        assert (await preview(viewer, stage, sid="foreign"))["error"]["code"] == 4016
        assert (await preview(viewer, stage, tool_call_id="read-1"))["error"]["code"] == 4016
        assert (await preview(viewer, stage, mime="image/gif"))["error"]["code"] == 4016

        # Prevent a real worker from executing a model; admission still travels
        # through the authenticated public canonical request and core store.
        monkeypatch.setattr(native.authority, "_schedule", lambda ref: None)
        queued = await admit_canonical(viewer, native.db, stage, mime=mime, request_id="real-" + mime)
        committed = queued["payload"]["attachments_v1"]["media"][0]["path"]
        assert committed != stage and "/native-inputs/" in committed
        assert Path(committed).parent.name == queued["payload"]["attachments_v1"]["media"][0]["sha256"]
        assert Path(committed).name == Path(stage).name
        # A genuine captured file is not yet sufficient: queued work is never authority.
        assert (await preview(viewer, committed))["error"]["code"] == 4016
        assert flush_committed_user(native.db, "owned", queued) == committed
        assert (await preview(viewer, committed))["error"]["code"] == 4016
        settle_core(native.db, "owned", native.authority.epoch)
        # claim_session_input advances runtime_generation and revokes the original stage lease.
        assert (await preview(viewer, stage))["error"]["code"] == 4016
        assert (await preview(viewer, committed, mime=mime))["result"]["content_base64"] == base64.b64encode(content).decode()

        assert (await rpc(viewer, "session.detach", {
            "session_id": "owned", "subscription_id": token}))["result"]["detached"] is True
        assert (await preview(viewer, committed))["error"]["code"] == 4001
        # The original staging leaf is disposable; resume must read the retained
        # core capture, on a FRESH real authorized subscription.
        Path(stage).unlink()
        await resume(viewer)
        answer = await preview(viewer, committed, mime=mime)
        assert answer["result"]["mime"] == mime and answer["result"]["bytes"] == len(content)
        assert answer["result"]["content_base64"] == base64.b64encode(content).decode()
        assert (await preview(different, committed, mime=mime))["result"]["bytes"] == len(content)
        assert (await preview(viewer, committed, sid="foreign"))["error"]["code"] == 4016
        assert (await preview(viewer, committed, tool_call_id="typed-only"))["error"]["code"] == 4016
        assert (await preview(viewer, committed, mime="application/pdf"))["error"]["code"] == 4016
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
async def test_canonical_requires_plugin_stage_real_receipt_and_exact_core_path(native, monkeypatch):
    viewer, foreign = connect(native.authority), connect(native.authority)
    try:
        await resume(viewer)
        await resume(foreign, "foreign")
        monkeypatch.setattr(native.authority, "_schedule", lambda ref: None)
        uploaded = await staged(viewer)
        assert "result" in uploaded, uploaded
        stage = uploaded["result"]["path"]
        # A durable typed marker for the original upload is not proof.
        flush_typed_user(native.db, "owned", stage)
        assert (await preview(viewer, stage))["result"]["bytes"] == len(PNG)
        queued = await admit_canonical(viewer, native.db, stage, request_id="failed-1")
        committed = flush_committed_user(native.db, "owned", queued)
        assert (await preview(viewer, committed))["error"]["code"] == 4016
        settle_core(native.db, "owned", native.authority.epoch, outcome="failed")
        assert (await preview(viewer, committed))["error"]["code"] == 4016
        assert (await preview(viewer, stage))["error"]["code"] == 4016
        assert (await preview(foreign, committed, sid="foreign"))["error"]["code"] == 4016

        # A second genuine capture of the SAME bytes is a separate filename,
        # and only its real completed receipt is eligible.
        second = (await staged(viewer))["result"]["path"]
        second_queued = await admit_canonical(viewer, native.db, second, request_id="completed-2")
        retained = flush_committed_user(native.db, "owned", second_queued)
        assert retained != committed
        settle_core(native.db, "owned", native.authority.epoch)
        assert (await preview(viewer, retained))["result"]["bytes"] == len(PNG)
        assert (await preview(viewer, committed))["error"]["code"] == 4016
        assert (await preview(viewer, second))["error"]["code"] == 4016

        # Same-byte copies and user-typed committed-path markers may not borrow
        # a different core receipt or a different successful plugin witness.
        copied = str(Path(retained).with_name("tern_upload_unproven.png"))
        shutil.copyfile(retained, copied)
        flush_typed_user(native.db, "owned", copied)
        assert (await preview(viewer, copied))["error"]["code"] == 4016
        assert (await preview(viewer, retained + "-renamed"))["error"]["code"] == 4016

        # A newly staged core-only attachment lacks plugin proof even if
        # the bytes, owning SID and profile otherwise match.
        from tui_gateway.prompt_attachments import stage_image_bytes
        from gateway.platforms.base import get_image_cache_dir
        unproven = stage_image_bytes(get_image_cache_dir(), PNG, ".png", prefix="core")
        unproven_row = await admit_canonical(viewer, native.db, unproven, request_id="core-only-3")
        unproven_retained = flush_committed_user(native.db, "owned", unproven_row)
        settle_core(native.db, "owned", native.authority.epoch)
        assert (await preview(viewer, unproven_retained))["error"]["code"] == 4016
    finally:
        await viewer.close()
        await foreign.close()


@pytest.mark.asyncio
async def test_committed_native_inputs_nofollow_links_and_replacement(native, monkeypatch):
    viewer = connect(native.authority)
    try:
        await resume(viewer)
        monkeypatch.setattr(native.authority, "_schedule", lambda ref: None)
        stage = (await staged(viewer))["result"]["path"]
        queued = await admit_canonical(viewer, native.db, stage, request_id="paths-1")
        committed = Path(flush_committed_user(native.db, "owned", queued))
        settle_core(native.db, "owned", native.authority.epoch)
        assert (await preview(viewer, str(committed)))["result"]["mime"] == "image/png"

        hardlink = committed.with_name("other.png")
        os.link(committed, hardlink)
        assert (await preview(viewer, str(committed)))["error"]["code"] == 4016
        hardlink.unlink()
        assert (await preview(viewer, str(committed)))["result"]["bytes"] == len(PNG)

        moved = committed.with_name("moved.png")
        committed.rename(moved)
        committed.symlink_to(moved)
        assert (await preview(viewer, str(committed)))["error"]["code"] == 4016
        committed.unlink()
        moved.rename(committed)

        # A symlink in a *parent* of the committed native file is refused even
        # if it still points at exactly the prior content-addressed directory.
        digest_root = committed.parent
        saved = digest_root.with_name(digest_root.name + "-saved")
        digest_root.rename(saved)
        digest_root.symlink_to(saved, target_is_directory=True)
        assert (await preview(viewer, str(committed)))["error"]["code"] == 4016
        digest_root.unlink()
        saved.rename(digest_root)

        stage_proof = Path(stage).with_name(Path(stage).name + ".tern-proof")
        original = stage_proof.read_bytes()
        stage_proof.write_bytes(b'{"version":2}')
        assert (await preview(viewer, str(committed)))["error"]["code"] == 4016
        stage_proof.write_bytes(original)
        assert (await preview(viewer, str(committed)))["result"]["bytes"] == len(PNG)

        # Replace an existing staging copy with identical bytes: inode fence.
        Path(stage).unlink()
        Path(stage).write_bytes(PNG)
        assert (await preview(viewer, str(committed)))["error"]["code"] == 4016
    finally:
        await viewer.close()

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
