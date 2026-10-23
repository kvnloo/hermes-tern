"""Caller-bound raster image delivery for the registered Hermes gateway method seam.

No core method overrides, transport tokens, local-host guesses or private history locks.
The only pending authority is a successful server-side byte upload plus its original
caller-bound lease. Resumed authority comes from paired, durable image bytes in state.db.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import os
import sqlite3
import stat
import threading
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict

from hermes_cli.plugin_gateway_methods import GatewayMethodFailure
from hermes_cli.plugin_gateway_scopes import GatewayScopeError

IMAGE_METHOD = "hermes-tern.media.image"
ATTACH_METHOD = "hermes-tern.media.attach_bytes"
PREVIEW_MAX_BYTES = 16 * 1024 * 1024
STAGING_MAX_BYTES = 20 * 1024 * 1024
STAGE_RECORD_LIMIT = 256
_MIMES = (
    (b"\x89PNG\r\n\x1a\n", "image/png", ".png"),
    (b"\xff\xd8\xff", "image/jpeg", ".jpg"),
    (b"GIF87a", "image/gif", ".gif"),
    (b"GIF89a", "image/gif", ".gif"),
)
_PENDING_LOCK = threading.Lock()


class ImageParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    path: str
    tool_call_id: str | None = None
    mime: str | None = None


class AttachParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    filename: str
    content_base64: str


@dataclass(frozen=True)
class _Owner:
    home: Path
    profile: str
    stored_id: str
    legacy: bool


@dataclass(frozen=True)
class _Stage:
    lease: Any
    sha256: str
    dev: int
    ino: int


_PENDING: OrderedDict[tuple[str, str, str, str], _Stage] = OrderedDict()


def _refuse(reason: str = "Image is not an authorized, current attachment") -> GatewayMethodFailure:
    return GatewayMethodFailure(4016, reason)


def _identity(request, params: dict) -> _Owner:
    request.assert_attached()
    if params.get("session_id") != request.session_id:
        raise _refuse("Image session does not match the attached request")
    from hermes_constants import get_hermes_home
    from tui_gateway.transport import current_transport

    home = Path(get_hermes_home()).resolve()
    transport = current_transport()
    if transport is None:
        # Canonical request.session_id is the durable SessionRef key.
        return _Owner(home, request.profile, request.session_id, False)

    # The legacy RPC SID is NOT its stored session key. This server helper
    # authenticates the exact current transport and attached session record.
    from tui_gateway import server
    attached_transport, session = server._current_session_steer_authority(request.session_id)
    if attached_transport is not transport or not isinstance(session, dict):
        raise _refuse("Legacy session transport is not attached")
    durable = session.get("session_key")
    profile_home = session.get("profile_home")
    if not isinstance(durable, str) or not durable:
        raise _refuse("Legacy durable session identity is unavailable")
    if profile_home is not None and Path(profile_home).resolve() != home:
        raise _refuse("Legacy session profile does not own this request")
    return _Owner(home, request.profile, durable, True)


def _mime(data: bytes) -> tuple[str, str]:
    for magic, mime, ext in _MIMES:
        if data.startswith(magic):
            return mime, ext
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    raise _refuse("Unsupported raster image bytes")


def _mime_matches(mime: str, declared: str | None) -> None:
    if declared is not None:
        parsed = declared.split(";", 1)[0].strip().lower()
        if parsed not in (mime, "application/octet-stream"):
            raise _refuse("Image MIME does not match its magic bytes")


def _roots(owner: _Owner) -> tuple[Path, Path]:
    # The canonical writer stages at cache/images, the legacy writer at images.
    # Both paths are profile-owned. No cwd, terminal host or viewer path is trusted.
    from gateway.platforms.base import get_image_cache_dir
    return (get_image_cache_dir().resolve(), (owner.home / "images").resolve())


def _key(owner: _Owner, path: str) -> tuple[str, str, str, str]:
    return (str(owner.home), owner.profile, owner.stored_id, path)


def _read_regular(path: Path, root: Path) -> tuple[bytes, os.stat_result]:
    """Open relative to an owned directory FD; reject symlinks, hardlinks and races."""
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    root_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        fd = os.open(path.name, flags, dir_fd=root_fd)
        try:
            initial = os.fstat(fd)
            if (not stat.S_ISREG(initial.st_mode) or initial.st_nlink != 1
                    or initial.st_size <= 0 or initial.st_size > PREVIEW_MAX_BYTES):
                raise _refuse("Image must be a bounded regular file")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                data = stream.read(PREVIEW_MAX_BYTES + 1)
            after = os.fstat(fd)
            named = os.stat(path.name, dir_fd=root_fd, follow_symlinks=False)
            if (not data or len(data) != initial.st_size or len(data) > PREVIEW_MAX_BYTES
                    or not stat.S_ISREG(named.st_mode)
                    or any(getattr(a, field) != getattr(b, field)
                           for a, b in ((initial, after), (initial, named))
                           for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns"))):
                raise _refuse("Image changed during the bounded read")
            # A renamed/replaced root must not permit a same-named foreign leaf.
            rooted = os.stat(root, follow_symlinks=False)
            opened_root = os.fstat(root_fd)
            if (rooted.st_dev, rooted.st_ino) != (opened_root.st_dev, opened_root.st_ino):
                raise _refuse("Image source directory was replaced")
            return data, initial
        finally:
            os.close(fd)
    finally:
        os.close(root_fd)


def _reference(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] in ("'", '"', chr(96)) and value[-1] == value[0]:
        return value[1:-1]
    return value


def _paired_history_image(message: dict, path: str, data: bytes) -> bool:
    """A plain typed marker has no authority: the *same durable user row* must
    contain an image_url part with the exact captured bytes in the matching slot.
    """
    if message.get("role") != "user":
        return False
    content = message.get("content")
    if not isinstance(content, list) or not content or not isinstance(content[0], dict):
        return False
    head = content[0]
    if head.get("type") != "text" or not isinstance(head.get("text"), str):
        return False
    references: list[str] = []
    for line in head["text"].splitlines():
        if line.startswith("@image:"):
            references.append(_reference(line[len("@image:"):]))
        elif line.startswith("[Image attached at: ") and line.endswith("]"):
            references.append(line[len("[Image attached at: "):-1])
    if not references or len(content) < len(references) + 1:
        return False
    for i, reference in enumerate(references):
        if reference != path:
            continue
        part = content[i + 1]
        if not isinstance(part, dict) or part.get("type") != "image_url":
            continue
        image_url = part.get("image_url")
        url = image_url.get("url") if isinstance(image_url, dict) else None
        if not isinstance(url, str):
            continue
        header, sep, encoded = url.partition(",")
        if (not sep or not header.lower().startswith("data:image/")
                or not header.lower().endswith(";base64")
                or not encoded or len(encoded) > ((PREVIEW_MAX_BYTES + 2) // 3) * 4):
            continue
        try:
            if base64.b64decode(encoded, validate=True) == data:
                return True
        except (binascii.Error, ValueError):
            continue
    return False


def _persisted(owner: _Owner, path: str, data: bytes) -> bool:
    # Public read-only state API preserves compression lineage and durable rows.
    # Never read private server histories, actor fields, or their locks.
    from hermes_state import SessionDB
    try:
        db = SessionDB(db_path=owner.home / "state.db", read_only=True)
    except (OSError, sqlite3.Error):
        return False
    try:
        if db.get_session(owner.stored_id) is None:
            return False
        return any(_paired_history_image(m, path, data) for m in
                   db.get_messages_as_conversation(owner.stored_id, include_ancestors=True))
    finally:
        db.close()


def _authority(owner: _Owner, request, path: str, data: bytes, fingerprint: os.stat_result) -> None:
    with _PENDING_LOCK:
        pending = _PENDING.get(_key(owner, path))
    if pending is not None:
        if (pending.sha256 != hashlib.sha256(data).hexdigest()
                or (pending.dev, pending.ino) != (fingerprint.st_dev, fingerprint.st_ino)):
            raise _refuse("Uploaded image source was replaced")
        try:
            # This is the current *different* registered read invocation, never
            # the original provisional upload request or a reconstructed token.
            pending.lease.assert_caller(request)
            return
        except GatewayScopeError:
            pass
    if not _persisted(owner, path, data):
        raise _refuse()


def read_image(request, params: dict) -> dict:
    owner = _identity(request, params)
    if params.get("tool_call_id"):
        # Neither request context has public compute-host provenance or exact
        # completed-tool attestation. A path/ID asserted by the client proves none.
        raise _refuse("Tool image preview requires authoritative gateway host and tool evidence")
    raw = params.get("path")
    if not isinstance(raw, str) or not raw or len(raw) > 4096 or not Path(raw).is_absolute():
        raise _refuse("Invalid image path")
    path = Path(raw)
    roots = _roots(owner)
    root = next((item for item in roots if path.parent == item), None)
    if root is None or path.name in (".", ".."):
        raise _refuse("Image path is outside this profile's staging directories")
    try:
        data, fingerprint = _read_regular(path, root)
    except (OSError, ValueError) as exc:
        raise _refuse("Image source is missing, nonregular or stale") from exc
    mime, _ = _mime(data)
    _mime_matches(mime, params.get("mime"))
    _authority(owner, request, raw, data, fingerprint)
    request.assert_attached()
    if _identity(request, params) != owner:
        raise _refuse("Image caller/session identity changed")
    # Source identity after provenance/DB reads: a removed or replaced file
    # must never become a ready SDK blob.
    try:
        named = os.lstat(path)
    except OSError as exc:
        raise _refuse("Image source disappeared after reading") from exc
    if (not stat.S_ISREG(named.st_mode)
            or any(getattr(named, field) != getattr(fingerprint, field)
                   for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns"))):
        raise _refuse("Image source was replaced after reading")
    with _PENDING_LOCK:
        pending = _PENDING.get(_key(owner, raw))
    if pending is not None:
        try:
            pending.lease.assert_caller(request)
        except GatewayScopeError:
            if not _persisted(owner, raw, data):
                raise _refuse("Image upload authority was revoked")
    request.assert_attached()
    return {"content_base64": base64.b64encode(data).decode("ascii"),
            "mime": mime, "bytes": len(data)}


def attach_bytes(request, params: dict) -> dict:
    owner = _identity(request, params)
    if owner.legacy:
        # Legacy image.attach_bytes also queues its private prompt list; a
        # plugin staging write cannot replace that core behavior.
        raise _refuse("Legacy sessions must use image.attach_bytes")
    encoded = params.get("content_base64")
    if (not isinstance(encoded, str) or not encoded
            or len(encoded) > ((STAGING_MAX_BYTES + 2) // 3) * 4):
        raise _refuse("Image staging exceeds its 20 MiB upload limit")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise _refuse("Invalid image staging base64") from exc
    if not data or len(data) > STAGING_MAX_BYTES:
        raise _refuse("Image staging exceeds its 20 MiB upload limit")
    mime, ext = _mime(data)
    lease = request.capture_scope()
    path: Path | None = None
    try:
        from gateway.platforms.base import get_image_cache_dir
        from tui_gateway.prompt_attachments import stage_image_bytes
        path = stage_image_bytes(get_image_cache_dir(), data, ext, prefix="tern_upload")
        request.assert_attached()
        if _identity(request, params) != owner:
            raise _refuse("Image staging owner changed")
        source = os.lstat(path)
        if not stat.S_ISREG(source.st_mode) or source.st_nlink != 1:
            raise _refuse("Image staging source is not regular")
        stage = _Stage(lease, hashlib.sha256(data).hexdigest(), source.st_dev, source.st_ino)
        with _PENDING_LOCK:
            _PENDING[_key(owner, str(path))] = stage
            removed = []
            while len(_PENDING) > STAGE_RECORD_LIMIT:
                removed.append(_PENDING.popitem(last=False)[1])
        for retired in removed:
            retired.lease.close()
        return {"attached": True, "path": str(path), "mime": mime,
                "name": path.name, "count": 1, "remainder": "",
                "text": f"[User attached image: {path.name}]", "bytes": len(data)}
    except BaseException:
        if path is not None:
            path.unlink(missing_ok=True)
        lease.close()
        raise


def register(ctx) -> None:
    ctx.register_gateway_method(IMAGE_METHOD, read_image, schema=ImageParams)
    ctx.register_gateway_method(ATTACH_METHOD, attach_bytes, schema=AttachParams)
