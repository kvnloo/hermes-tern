"""Plugin-owned Tern browser blocks, task claims and exact-answer cleanup.

Native operations follow Tern's documented browser JSON interface. Shared claims
prevent a different profile/session from treating a listing, URL or title as
ownership. Ported from the Hermes ui-tsp browser provider, not installed in core.
"""
from __future__ import annotations

import logging
import re
import subprocess
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Callable

from .browser_transport import NativeBrowserError, TernBrowserCLI, exact_block

_FRAME = re.compile(r"(?:main|(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))*)\Z")
_ID = re.compile(r"[1-9][0-9]*\Z")
logger = logging.getLogger(__name__)


def block_id(value: Any) -> int:
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise NativeBrowserError("invalid")
    return int(value)


def frame_path(value: Any) -> str:
    if not isinstance(value, str) or _FRAME.fullmatch(value) is None:
        raise NativeBrowserError("invalid")
    return value


@dataclass
class Target:
    block: int
    adopted: bool
    frame: str = "main"


@dataclass
class BrowserScope:
    """Original server-authorized session, viewer and publisher; never retarget."""

    profile: str
    rpc_session_id: str
    viewer_session_id: str
    task_id: str
    tool_session_id: str | None
    pane_vars: tuple[tuple[str, str], ...]
    pane: int
    window: str
    window_scope: tuple[str, str, str]
    lease: Any = field(repr=False)
    cli: TernBrowserCLI = field(repr=False)
    driver: BrowserDriver | None = field(default=None, repr=False)

    def require_caller(self, request: Any) -> None:
        """A live registered RPC must match this scope's ORIGINAL gateway caller."""
        check = getattr(self.lease, "assert_caller", None)
        if not callable(check):
            raise NativeBrowserError("unsupported")
        check(request)
        self.require_current()

    def require_current(self) -> None:
        from gateway.session_authorities import served_profile_name
        from hermes_constants import get_hermes_home
        from . import tern_env

        self.lease.assert_current()
        if served_profile_name(get_hermes_home()) != self.profile:
            raise NativeBrowserError("ownership")
        if tuple(sorted(tern_env.pane_env(self.viewer_session_id).items())) != self.pane_vars:
            raise NativeBrowserError("ownership")


class BrowserDriver:
    def __init__(self, scope: BrowserScope):
        self.scope = scope
        self.target: Target | None = None
        self.pending_releases: set[int] = set()
        self.pending_open = False
        self.unknown_open = False
        # A leftover claim outlives its *revoked* plugin registration. A new
        # registration cannot become the original caller or adopt its pages.
        self.retired = False
        self.lock = _LOCK
        scope.driver = self

    def request(self, op: dict) -> dict:
        if self.retired:
            raise NativeBrowserError("permanently_quarantined")
        self.scope.require_current()
        checker = _EFFECT_FENCE.get()
        if checker is not None:
            checker()  # original RPC task/busy authority immediately before each effect
        return self.scope.cli(op)

    def _taken(self, block: int) -> bool:
        return any(
            other.scope.window_scope == self.scope.window_scope and (
                block in other.pending_releases
                or (other.target is not None and other.target.block == block))
            for other in _DRIVERS.values()
        )

    def _quarantined(self) -> bool:
        return any(
            other.scope.window_scope == self.scope.window_scope and (
                other.pending_open or other.unknown_open or other.scope.cli.unknown)
            for other in _DRIVERS.values()
        )

    def _blocks(self) -> list[dict]:
        answer = self.request({"op": "blocks"})
        entries = answer.get("blocks")
        if not isinstance(entries, list):
            raise NativeBrowserError("protocol")
        return [
            b for b in entries if isinstance(b, dict)
            and type(b.get("block")) is int and b["block"] > 0
        ]

    def listing(self) -> list[dict]:
        with self.lock:
            self.reconcile_open()
            return [
                {
                    "target_id": str(b["block"]),
                    "url": b.get("url") if isinstance(b.get("url"), str) else "about:blank",
                    "title": b.get("title") if isinstance(b.get("title"), str) else "",
                    "owner": b.get("owner") if type(b.get("owner")) is int else None,
                    "owned": self.target is not None and self.target.block == b["block"],
                    "available": b.get("driven") is False and not self._taken(b["block"])
                                 and not self._quarantined(),
                }
                for b in self._blocks()
            ]

    def owned(self, chosen: str | None = None) -> Target:
        if self.retired:
            raise NativeBrowserError("permanently_quarantined")
        self.scope.require_current()
        target = self.target
        if target is None or (chosen is not None and target.block != block_id(chosen)):
            raise NativeBrowserError("ownership")
        return target

    def identity(self) -> dict:
        target = self.owned()
        state = self.request({"op": "state", "block": target.block})
        title, url = state.get("title"), state.get("url")
        if not isinstance(title, str) or not isinstance(url, str):
            raise NativeBrowserError("protocol")
        return {
            "target_id": str(target.block), "title": title, "url": url, "in_tern": True,
            **({"frame": target.frame} if target.frame != "main" else {}),
        }

    def _release_pending(self) -> None:
        for block in tuple(self.pending_releases):
            self.request({"op": "release", "block": block})
            self.pending_releases.remove(block)

    def reconcile_open(self) -> None:
        """Only the exact late open reply may identify the page to close."""
        with self.lock:
            if self.retired:
                raise NativeBrowserError("permanently_quarantined")
            if not self.pending_open:
                if self.unknown_open:
                    raise NativeBrowserError("open_unknown")
                return
            # Authorization is not a native CLI answer: a denied late read
            # must not consume the original process or change its open state.
            # Scope, consent, handler and CDP checks precede reply handling.
            self.scope.require_current()
            checker = _EFFECT_FENCE.get()
            if checker is not None:
                checker()
            try:
                answer = self.scope.cli.reconcile_open()
                block = exact_block(answer)
                if self._taken(block):
                    self.unknown_open = True
                    raise NativeBrowserError("open_unknown")
                self.target = Target(block, False)
                self.pending_open = False
                self.close()
            except NativeBrowserError as exc:
                if exc.kind not in {"open_pending", "unsupported", "invalid", "no_window"}:
                    self.unknown_open = True
                if exc.kind in {"unsupported", "invalid", "no_window"}:
                    self.pending_open = False
                raise

    def adopt(self, chosen: str) -> dict:
        block = block_id(chosen)
        with self.lock:
            self.scope.require_current()
            self.reconcile_open()
            if self._quarantined():
                raise NativeBrowserError("open_pending")
            if self.target is not None and self.target.block == block:
                return self.identity()
            entry = next((b for b in self._blocks() if b["block"] == block), None)
            if entry is None or entry.get("driven") is not False or self._taken(block):
                raise NativeBrowserError("ownership")
            # Snapshot may attach a delegate even if the reply is lost.
            # A failed probe is cleanup-only and never grants model drive.
            self.pending_releases.add(block)
            try:
                self.request({"op": "snapshot", "block": block, "nodes": 1})
            except (NativeBrowserError, OSError, subprocess.SubprocessError):
                self._release_pending()
                raise
            # Keep the old claim until its cleanup is acknowledged.
            try:
                self.close()
            except (NativeBrowserError, OSError, subprocess.SubprocessError):
                self._release_pending()
                raise
            self.pending_releases.remove(block)
            self.target = Target(block, True)
            try:
                return self.identity()
            except (NativeBrowserError, OSError, subprocess.SubprocessError):
                self.close()
                raise

    def focus(self, chosen: str) -> dict:
        with self.lock:
            target = self.owned(chosen)
            # Focus only the exact original window and exact claimed native block.
            checker = _EFFECT_FENCE.get()
            if checker is not None:
                checker()
            self.scope.cli.invoke(["focus", str(target.block), "--json"])
            return self.identity()

    def select_frame(self, chosen: str, frame: str) -> dict:
        frame_path(frame)
        with self.lock:
            target = self.owned(chosen)
            # Evaluation-only frame proof. No snapshot/act/nav/capture frame API.
            self.request({
                "op": "eval", "block": target.block, "world": "page",
                "function": "function () { return location.href; }",
                **({"frame": frame} if frame != "main" else {}),
            })
            state = self.identity()
            target.frame = frame
            state.pop("frame", None)
            if frame != "main":
                state["frame"] = frame
            return state

    def close(self) -> None:
        with self.lock:
            target = self.target
            if target is None:
                return
            # Release adopted pages; ONLY close blocks created by this agent.
            self.request({"op": "release" if target.adopted else "close", "block": target.block})
            self.target = None

    def release(self, chosen: str) -> dict:
        with self.lock:
            self.owned(chosen)
            self.close()  # failed cleanup retains the claim for explicit retry
            return {"target_id": chosen, "released": True}

    def open(self, url: str) -> dict:
        with self.lock:
            self.scope.require_current()
            self.reconcile_open()
            if self._quarantined():
                raise NativeBrowserError("open_pending")
            if self.target is None:
                try:
                    answer = self.request({"op": "open", "owner": self.scope.pane, "url": "about:blank"})
                except NativeBrowserError as exc:
                    if exc.kind not in {"unsupported", "invalid", "no_window", "unavailable"}:
                        self.pending_open = True
                    raise
                block = exact_block(answer)
                if self._taken(block):
                    self.unknown_open = True
                    raise NativeBrowserError("open_unknown")
                self.target = Target(block, False)
                try:
                    self.request({"op": "snapshot", "block": block, "nodes": 1})
                except NativeBrowserError:
                    self.close()
                    raise
            target = self.owned()
            if target.frame != "main":
                raise NativeBrowserError("unsupported")
            self.request({"op": "goto", "block": target.block, "url": url})
            return self.identity()

    def command(self, action: str, *args: str) -> dict:
        with self.lock:
            self.scope.require_current()
            self.reconcile_open()
            if self.pending_releases:
                raise NativeBrowserError("ownership")
            target = self.owned()
            if target.frame != "main" and action != "eval":
                raise NativeBrowserError("unsupported")
            ref = lambda value: value.removeprefix("@")
            operations: dict[str, Callable[[], dict]] = {
                "snapshot": lambda: {"op": "snapshot", "format": "text", "nodes": 3000},
                "click": lambda: {"op": "act", "action": "click", "ref": ref(args[0])},
                "fill": lambda: {"op": "act", "action": "fill", "ref": ref(args[0]), "text": args[1]},
                "press": lambda: {"op": "input", "events": press_events(args[0])},
                "scroll": lambda: {"op": "input", "events": [
                    {"type": "wheel", "x": 1, "y": 1, "dx": 0,
                     "dy": -500 if args[0] == "up" else 500}]},
                "back": lambda: {"op": "nav", "go": "back"},
                "eval": lambda: {
                    "op": "eval", "function": f"function () {{ return ({args[0]}); }}",
                    "world": "page", **({"frame": target.frame} if target.frame != "main" else {})},
                "state": lambda: {"op": "state"},
                "capture": lambda: {"op": "capture", "format": "png", "full": True},
            }
            if action not in operations:
                raise NativeBrowserError("unsupported")
            try:
                op = operations[action]()
            except (IndexError, TypeError, ValueError) as exc:
                raise NativeBrowserError("invalid") from exc
            result = self.request({**op, "block": target.block})
            identity = self.identity()
            data = {**result, "url": identity["url"], "title": identity["title"]}
            if action == "snapshot":
                data["snapshot"] = result.get("text", result.get("tree", ""))
            if action == "eval":
                data["result"] = result.get("value")
            return {"success": True, "data": data, "tern_target": identity}


def press_events(combo: str) -> list[dict]:
    if not isinstance(combo, str) or not combo:
        raise NativeBrowserError("invalid")
    names = combo.split("+")
    modifiers = {"Control": "ctrl", "Ctrl": "ctrl", "Alt": "alt", "Shift": "shift", "Meta": "meta"}
    down: list[dict] = []
    active: list[str] = []
    for item in names:
        if not item:
            raise NativeBrowserError("invalid")
        key = "Control" if item == "Ctrl" else item
        down.append({"type": "key", "action": "down", "key": key, "mods": list(active)})
        if item in modifiers:
            active.append(modifiers[item])
    up = []
    for item in reversed(down):
        key = item["key"]
        if key in modifiers and modifiers[key] in active:
            active.remove(modifiers[key])
        up.append({"type": "key", "action": "up", "key": key, "mods": list(active)})
    return down + up


_EFFECT_FENCE: ContextVar[Callable[[], None] | None] = ContextVar('tern_effect_fence', default=None)

@contextmanager
def effect_fence(check: Callable[[], None]):
    token = _EFFECT_FENCE.set(check)
    try:
        yield
    finally:
        _EFFECT_FENCE.reset(token)


_LOCK = threading.RLock()
_DRIVERS: dict[tuple[str, str], BrowserDriver] = {}


def get_driver(profile: str, rpc_session_id: str) -> BrowserDriver | None:
    """Exact live RPC slot; a durable session key is never accepted as an alias."""
    with _LOCK:
        return _DRIVERS.get((profile, rpc_session_id))


def get_driver_for_tool(profile: str, tool_session_id: str, task_id: str) -> BrowserDriver | None:
    """Resolve the commissioned driver through one exact trusted task identity.

    A stale agent SID or duplicate task must fail closed, never fall back to
    another browser. No loose session aliases are cached.
    """
    with _LOCK:
        matches = [driver for (name, _), driver in _DRIVERS.items()
                   if name == profile and driver.scope.task_id == task_id]
        if not matches:
            return None
        if (len(matches) != 1 or matches[0].scope.tool_session_id != tool_session_id):
            raise NativeBrowserError("ownership")
        return matches[0]


def has_native_driver(profile: str) -> bool:
    """Side-effect-free availability witness for previously commissioned sessions."""
    with _LOCK:
        return any(name == profile and not driver.retired and bool(driver.scope.tool_session_id)
                   and not getattr(getattr(driver.scope.lease, "cancellation", None),
                                   "is_set", lambda: False)()
                   for (name, _), driver in _DRIVERS.items())


def has_quarantined_task(profile: str, task_id: str) -> bool:
    """Never give another RPC slot a durable task's retired native claim."""
    with _LOCK:
        return any(name == profile and driver.retired and driver.scope.task_id == task_id
                   for (name, _), driver in _DRIVERS.items())


def register_driver(scope: BrowserScope) -> BrowserDriver:
    with _LOCK:
        key = (scope.profile, scope.rpc_session_id)
        if (key in _DRIVERS or not scope.tool_session_id
                or any(name == scope.profile and driver.scope.task_id == scope.task_id
                       for (name, _), driver in _DRIVERS.items())):
            # A resume must not duplicate an unacknowledged native claim for
            # the same durable task. The old original lease owns its cleanup.
            raise NativeBrowserError("ownership")
        driver = BrowserDriver(scope)
        _DRIVERS[key] = driver
        return driver


def unload_profile(profile: str) -> None:
    """Retain unknown or unacknowledged native claims; never force cleanup with a revoked lease."""
    cleanup_errors: tuple[type[Exception], ...] = (
        NativeBrowserError, OSError, subprocess.SubprocessError, PermissionError,
    )
    try:
        from hermes_cli.plugin_gateway_scopes import GatewayScopeError
    except ImportError:
        # A pinned older Hermes without plugin scopes may still unload safely.
        pass
    else:
        cleanup_errors += (GatewayScopeError,)
    with _LOCK:
        for key, driver in tuple(_DRIVERS.items()):
            if key[0] != profile or driver.retired:
                continue
            try:
                driver.reconcile_open()
                driver._release_pending()
                driver.close()
            except cleanup_errors as exc:
                # A revoked original caller cannot close a page: log the refusal
                # and KEEP the claim/quarantine, never attempt another backend.
                logger.warning(
                    "Native browser unload deferred unacknowledged cleanup (%s); retaining original claim",
                    type(exc).__name__,
                )
            if (driver.target or driver.pending_open or driver.unknown_open
                    or driver.pending_releases or driver.scope.cli.unknown):
                # The original registration is being disposed. This claim is
                # permanently quarantined, even if consent returns later.
                driver.retired = True
                logger.warning("Native browser claim permanently quarantined on unload")
            else:
                driver.scope.lease.close()
                _DRIVERS.pop(key, None)
