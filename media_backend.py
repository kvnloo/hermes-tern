"""Caller-bound raster image delivery for the registered Hermes gateway method seam.

No core overrides, private legacy transport inspection, or guessed host identity.
Pending authority requires a successful scoped upload lease. Resumed authority
requires a real, terminal canonical admission of matching bytes AND an owning
durable user-row reference; text-only persistence cannot carry image bytes.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
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
    alias: Path
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

    # A configured HERMES_HOME symlink is one supported alias. Do not resolve
    # children of that home (cache/images), where symlinks are forbidden.
    alias = Path(os.path.abspath(get_hermes_home()))
    home = alias.resolve(strict=True)
    legacy = current_transport() is not None
    # Legacy transports expose no PUBLIC live-SID -> durable-key projection.
    # In that mode preview cannot infer an owning durable user conversation;
    # retain the original core upload path and refuse unsupported preview.
    return _Owner(home, alias, request.profile, request.session_id, legacy)

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


def _roots(owner: _Owner) -> tuple[Path, ...]:
    """Only configured HOME-relative core staging roots, including HOME alias.

    Never use Path.resolve() on a cache child: that would authorize a symlink
    planted below the configured home. get_image_cache_dir may select the
    genuine legacy 'image_cache' fallback, but not an arbitrary external root.
    """
    from gateway.platforms.base import get_image_cache_dir

    cache = Path(os.path.abspath(get_image_cache_dir()))
    try:
        rel = cache.relative_to(owner.alias)
    except ValueError:
        try:
            rel = cache.relative_to(owner.home)
        except ValueError as exc:
            raise _refuse("Image cache is outside the configured profile") from exc
    if rel.parts not in (("cache", "images"), ("image_cache",)):
        raise _refuse("Image cache is not a supported profile staging root")
    paths: list[Path] = []
    for suffix in (rel, Path("images")):
        for home in (owner.alias, owner.home):
            candidate = home / suffix
            if candidate not in paths:
                paths.append(candidate)
    return tuple(paths)


def _root_parts(root: Path) -> tuple[Path, tuple[str, ...]]:
    from hermes_constants import get_hermes_home

    configured = Path(os.path.abspath(get_hermes_home()))
    for home in (configured, configured.resolve(strict=True)):
        try:
            parts = root.relative_to(home).parts
        except ValueError:
            continue
        if parts and all(p not in ("", ".", "..") for p in parts):
            return configured, parts
    raise _refuse("Image root is not inside the configured profile")


def _open_staging_root(root: Path) -> tuple[int, list[tuple[int, str, int]]]:
    """Follow only the configured HOME alias; open each child using NOFOLLOW.

    The ancestry witness records parent-fd/name/child-fd for post-read
    no-follow revalidation, so renames cannot redirect a permitted root.
    """
    home, parts = _root_parts(root)
    fd = os.open(home, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    chain: list[tuple[int, str, int]] = []
    try:
        initial = os.fstat(fd)
        now = os.stat(home)
        if (initial.st_dev, initial.st_ino) != (now.st_dev, now.st_ino):
            raise _refuse("Configured home changed")
        for component in parts:
            child = os.open(component, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                            | getattr(os, "O_NOFOLLOW", 0), dir_fd=fd)
            try:
                opened = os.fstat(child)
                named = os.stat(component, dir_fd=fd, follow_symlinks=False)
                if (not stat.S_ISDIR(named.st_mode)
                        or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)):
                    raise _refuse("Image root contains an untrusted link")
                chain.append((fd, component, child))
                fd = child
            except BaseException:
                os.close(child)
                raise
        return fd, chain
    except BaseException:
        for _, _, child in reversed(chain):
            os.close(child)
        os.close(chain[0][0] if chain else fd)
        raise


def _close_staging_root(fd: int, chain: list[tuple[int, str, int]]) -> None:
    if chain:
        for _, _, child in reversed(chain):
            os.close(child)
        os.close(chain[0][0])
    else:
        os.close(fd)


def _check_staging_root(root: Path, fd: int, chain: list[tuple[int, str, int]]) -> None:
    from hermes_constants import get_hermes_home

    configured = Path(os.path.abspath(get_hermes_home()))
    home_fd = chain[0][0] if chain else fd
    current = os.stat(configured)
    opened = os.fstat(home_fd)
    if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
        raise _refuse("Configured home changed during image read")
    for parent, component, child in chain:
        named = os.stat(component, dir_fd=parent, follow_symlinks=False)
        opened = os.fstat(child)
        if (not stat.S_ISDIR(named.st_mode)
                or (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino)):
            raise _refuse("Image root changed during image read")
    named_root = os.stat(root, follow_symlinks=False)
    opened_root = os.fstat(fd)
    if (not stat.S_ISDIR(named_root.st_mode)
            or (named_root.st_dev, named_root.st_ino) != (opened_root.st_dev, opened_root.st_ino)):
        raise _refuse("Image source directory was replaced")

def _key(owner: _Owner, path: str) -> tuple[str, str, str, str]:
    return (str(owner.home), owner.profile, owner.stored_id, path)


def _read_regular(path: Path, root: Path) -> tuple[bytes, os.stat_result]:
    """Bounded no-follow leaf read under an independently walked profile root."""
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    root_fd, chain = _open_staging_root(root)
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
                    or not stat.S_ISREG(named.st_mode) or named.st_nlink != 1
                    or any(getattr(a, field) != getattr(b, field)
                           for a, b in ((initial, after), (initial, named))
                           for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns"))):
                raise _refuse("Image changed during the bounded read")
            _check_staging_root(root, root_fd, chain)
            return data, initial
        finally:
            os.close(fd)
    finally:
        _close_staging_root(root_fd, chain)

def _reference(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] in ("'", '"', chr(96)) and value[-1] == value[0]:
        return value[1:-1]
    return value


def _references_path(text: str, path: str) -> bool:
    """Recognize the genuine prompt reference syntax, not a substring match."""
    for line in text.splitlines():
        if line.startswith("@image:") and _reference(line[len("@image:"):]) == path:
            return True
        if line.startswith("[Image attached at: ") and line.endswith("]"):
            if line[len("[Image attached at: "):-1] == path:
                return True
    return False


def _proof_name(path: Path) -> str:
    return path.name + ".tern-proof"


def _stage_proof(owner: _Owner, path: Path, data: bytes, source: os.stat_result) -> None:
    """Write a private per-image witness after actual staging, not from user text.

    The witness never independently grants a preview: a matching terminal
    canonical admission AND persisted owning user row are still required.
    """
    proof = {
        "version": 1, "profile": owner.profile, "stored_id": owner.stored_id,
        "path": str(path), "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data), "dev": source.st_dev, "ino": source.st_ino,
    }
    content = json.dumps(proof, sort_keys=True, separators=(",", ":")).encode("utf8")
    fd, chain = _open_staging_root(path.parent)
    try:
        proof_fd = os.open(_proof_name(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL
                           | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=fd)
        try:
            with os.fdopen(proof_fd, "wb", closefd=False) as out:
                out.write(content)
                out.flush()
                os.fsync(out.fileno())
            _check_staging_root(path.parent, fd, chain)
        finally:
            os.close(proof_fd)
    finally:
        _close_staging_root(fd, chain)


def _stage_attested(owner: _Owner, path: Path, data: bytes, source: os.stat_result) -> bool:
    if owner.legacy:
        return False
    try:
        root_fd, chain = _open_staging_root(path.parent)
        try:
            proof_fd = os.open(_proof_name(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                               dir_fd=root_fd)
            try:
                before = os.fstat(proof_fd)
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 4096:
                    return False
                with os.fdopen(proof_fd, "rb", closefd=False) as stream:
                    raw = stream.read(4097)
                after = os.fstat(proof_fd)
                named = os.stat(_proof_name(path), dir_fd=root_fd, follow_symlinks=False)
                if (len(raw) != before.st_size or not stat.S_ISREG(named.st_mode)
                        or any((a.st_dev, a.st_ino, a.st_size, a.st_mtime_ns) !=
                               (b.st_dev, b.st_ino, b.st_size, b.st_mtime_ns)
                               for a, b in ((before, after), (before, named)))):
                    return False
                _check_staging_root(path.parent, root_fd, chain)
            finally:
                os.close(proof_fd)
        finally:
            _close_staging_root(root_fd, chain)
        proof = json.loads(raw)
        expected = {
            "version": 1, "profile": owner.profile, "stored_id": owner.stored_id,
            "path": str(path), "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data), "dev": source.st_dev, "ino": source.st_ino,
        }
        return type(proof) is dict and proof == expected
    except (OSError, ValueError, json.JSONDecodeError, TypeError):
        return False


def _persisted(owner: _Owner, path: str, data: bytes) -> bool:
    """Require two independent production records, not an impossible image_url row.

    Core session_persistence._durable_content converts all image_url parts to
    text. A user-typed path or screenshot marker cannot grant access. A canonical
    terminal prompt admission, committed by core with the SHA-256 of its captured
    image bytes, is independent proof. Legacy has no public durable-key mapping or
    prompt admission receipt, so no legacy persisted fallback is attempted.
    """
    if owner.legacy:
        return False
    from hermes_state import SessionDB
    from hermes_state_runtime import list_session_admissions

    try:
        db = SessionDB(db_path=owner.home / "state.db", read_only=True)
    except (OSError, sqlite3.Error):
        return False
    try:
        if db.get_session(owner.stored_id) is None:
            return False
        if not _stage_attested(owner, Path(path), data, os.lstat(path)):
            return False
        conversation = db.get_messages_as_conversation(owner.stored_id, include_ancestors=True)
        if not any(m.get("role") == "user" and isinstance(m.get("content"), str)
                   and _references_path(m["content"], path) for m in conversation):
            return False
        digest = hashlib.sha256(data).hexdigest()
        # Do not accept queued/cancelled/failed work, foreign admissions,
        # forged typed hints, or a different image with the same file name.
        for row in list_session_admissions(db, session_id=owner.stored_id, pending_only=False):
            if row.get("status") != "terminal" or row.get("outcome") != "completed":
                continue
            attached = row.get("payload", {}).get("attachments_v1", {})
            media = attached.get("media")
            mimes = attached.get("media_types")
            if not isinstance(media, list) or not isinstance(mimes, list) or len(media) != len(mimes):
                continue
            for ref, mime in zip(media, mimes):
                if (isinstance(ref, dict) and ref.get("sha256") == digest
                        and ref.get("size") == len(data) and mime == _mime(data)[0]):
                    return True
        return False
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
        return False
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
    if root is None or path.name in (".", "..") or ".." in path.parts:
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
        # Original legacy image.attach_bytes queues the exact image bytes once.
        # Plugin staging cannot substitute for this private queued-image seam.
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
        directory = get_image_cache_dir()
        if directory not in _roots(owner):
            raise _refuse("Image staging directory does not belong to this profile")
        directory_fd, chain = _open_staging_root(directory)
        try:
            _check_staging_root(directory, directory_fd, chain)
        finally:
            _close_staging_root(directory_fd, chain)
        path = stage_image_bytes(directory, data, ext, prefix="tern_upload")
        request.assert_attached()
        if _identity(request, params) != owner:
            raise _refuse("Image staging owner changed")
        source = os.lstat(path)
        if not stat.S_ISREG(source.st_mode) or source.st_nlink != 1:
            raise _refuse("Image staging source is not regular")
        _stage_proof(owner, path, data, source)
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
            path.with_name(_proof_name(path)).unlink(missing_ok=True)
            path.unlink(missing_ok=True)
        lease.close()
        raise


def register(ctx) -> None:
    ctx.register_gateway_method(IMAGE_METHOD, read_image, schema=ImageParams)
    ctx.register_gateway_method(ATTACH_METHOD, attach_bytes, schema=AttachParams)
