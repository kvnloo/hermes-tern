"""Hermes-tern browser gateway ownership and consented, policy-routed tool adapter.

No core patches, alternate RPC router or middleware executor: all model actions
enter Hermes through PluginContext.register_tool(override=True). The generic
GatewayScopeLease.assert_caller(current_request) proves the original attached
RPC peer, independent of the legacy task/busy fence. Canonical sessions
without an equivalent trusted task/busy projection remain read-only.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict, Field

from . import tern_env
from .browser_native import (
    BrowserDriver, BrowserScope, NativeBrowserError, TernBrowserCLI,
    effect_fence, get_driver, get_driver_for_tool, has_native_driver, register_driver, unload_profile,
)

logger = logging.getLogger(__name__)
PLUGIN = "hermes-tern"
METHODS = ("blocks", "adopt", "focus", "release", "frame")
_TOOL_NAMES = (
    "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
    "browser_scroll", "browser_back", "browser_press", "browser_console",
    "browser_get_images", "browser_vision",
)
_PROFILE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*\Z")
_ID = re.compile(r"[1-9][0-9]*\Z")
_NATIVE_HANDLERS: dict[str, dict[str, Callable]] = {}
_NATIVE_LOCK = threading.RLock()


class BlocksParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(min_length=1)


class TargetParams(BlocksParams):
    target_id: str = Field(pattern=r"^[1-9][0-9]*$")


class FrameParams(TargetParams):
    frame: str = Field(pattern=r"^(main|(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))*)$")


def _profile(request) -> str:
    from gateway.session_authorities import served_profile_name
    from hermes_constants import get_hermes_home

    request.assert_attached()
    profile = request.profile
    if not isinstance(profile, str) or not _PROFILE.fullmatch(profile):
        raise PermissionError("canonical profile identity is unavailable")
    if served_profile_name(get_hermes_home()) != profile:
        raise PermissionError("browser profile scope changed")
    return profile


def _viewer(sid: str) -> tuple[int, str, tuple[tuple[str, str], ...], dict[str, str], str, tuple[str, str, str]]:
    """The live viewer supplies coordinates, not authority. Freeze the exact pane."""
    from hermes_platform.resolver import LookupContext, locate_command
    from tools.environments.local import served_profile_child_env

    tern = tern_env.pane_env(sid)
    pane = tern.get("TERN_PANE", "")
    window = tern.get("TERN_WINDOW_KEY", "")
    if not isinstance(pane, str) or not _ID.fullmatch(pane) or not isinstance(window, str) or not window:
        raise NativeBrowserError("unavailable")
    base = served_profile_child_env(inherit_credentials=False)
    path = base.get("PATH", "")
    resolved = locate_command("tern", LookupContext(path=path))
    if not resolved.found or not resolved.command:
        raise NativeBrowserError("unavailable")
    # A minimal, credential-free environment for Tern. No caller-supplied
    # profile selector or subprocess shell; Tern's own window key is pinned.
    clean = {name: base[name] for name in ("PATH", "HOME", "TERM", "LANG", "TERN_CONFIG_DIR")
             if isinstance(base.get(name), str)}
    clean.update(tern)
    scope = (window, tern.get("TERN_DAEMON_SOCKET", ""), clean.get("TERN_CONFIG_DIR", ""))
    return int(pane), window, tuple(sorted(tern.items())), clean, resolved.command[0], scope


@dataclass(frozen=True)
class LegacyIdentity:
    """Identifiers read from the attached runtime's trusted legacy owner.

    rpc_session_id identifies the live attached gateway slot/lease. The
    conversation's durable key names the viewer marker and the prompt task.
    tool_session_id is read from the actual built agent (tool_executor's
    session_id), not presumed equal to either other identifier.
    """

    rpc_session_id: str
    viewer_session_id: str
    task_id: str
    tool_session_id: str | None


def _legacy_identity(sid: str, profile: str) -> tuple[dict, LegacyIdentity] | None:
    owner = _legacy_owner(sid, profile)
    if owner is None:
        return None
    durable = owner.get("session_key")
    if not isinstance(durable, str) or not durable:
        return None
    agent = owner.get("agent")
    tool_sid = getattr(agent, "session_id", None) if agent is not None else None
    if not isinstance(tool_sid, str) or not tool_sid:
        tool_sid = None  # construction not finished: read-only, never grant native drive
    return owner, LegacyIdentity(
        rpc_session_id=sid,
        viewer_session_id=durable,
        task_id=durable,  # prompt_turn passes owner["session_key"] as run task_id
        tool_session_id=tool_sid,
    )


def _legacy_owner(sid: str, profile: str) -> dict | None:
    """Read the real legacy steer owner; never synthesize one for canonical."""
    try:
        from tui_gateway import server
        from gateway.session_authorities import served_profile_name

        _, owner = server._current_session_steer_authority(sid)
        if not isinstance(owner, dict) or not isinstance(owner.get("session_key"), str):
            return None
        home = owner.get("profile_home")
        if home is not None and served_profile_name(home) != profile:
            return None
        return owner
    except (ImportError, AttributeError, OSError, RuntimeError):
        return None


def _consented(ctx) -> bool:
    """Dynamic permission read: a revoked operator grant immediately blocks effects."""
    try:
        return ctx.has_capability("tools.override") is True
    except (AttributeError, RuntimeError, OSError, ValueError):
        return False


def _native_tools_ready(ctx, profile: str) -> bool:
    """Live grant AND the original override handlers still selected in the real registry."""
    if not _consented(ctx) or ctx.profile_name != profile:
        return False
    from tools.registry import registry

    with _NATIVE_LOCK:
        handlers = _NATIVE_HANDLERS.get(profile)
        if handlers is None or set(handlers) != set(_TOOL_NAMES):
            return False
        return all(
            (entry := registry.get_entry(name)) is not None
            and entry.handler is handler
            for name, handler in handlers.items()
        )


def _forget_native_tools(profile: str, handlers: dict[str, Callable]) -> None:
    with _NATIVE_LOCK:
        if _NATIVE_HANDLERS.get(profile) is handlers:
            _NATIVE_HANDLERS.pop(profile, None)


def _new_scope(request, profile: str, ids: LegacyIdentity) -> BrowserScope:
    pane, window, pane_vars, env, executable, window_scope = _viewer(ids.viewer_session_id)
    lease = request.capture_scope()
    return BrowserScope(
        profile=profile, rpc_session_id=ids.rpc_session_id,
        viewer_session_id=ids.viewer_session_id,
        task_id=ids.task_id, tool_session_id=ids.tool_session_id,
        pane_vars=pane_vars, pane=pane, window=window,
        window_scope=window_scope, lease=lease,
        cli=TernBrowserCLI(executable, env, window),
    )


def _driver(request, ctx, *, require_owner: bool) -> BrowserDriver:
    """The live RPC lookup never uses a durable marker or a model-tool hint."""
    profile = _profile(request)
    sid = request.session_id
    current = get_driver(profile, sid)
    if current is None:
        raise NativeBrowserError("unsupported")
    scope = current.scope
    scope.require_caller(request)  # original live RPC peer, NOT legacy steer membership
    resolved = _legacy_identity(sid, profile)
    if require_owner and resolved is None:
        raise NativeBrowserError("unavailable")
    if not _native_tools_ready(ctx, profile):
        raise NativeBrowserError("unsupported")
    if resolved is None:
        raise NativeBrowserError("ownership")
    owner, ids = resolved
    if (scope.rpc_session_id != ids.rpc_session_id
            or scope.viewer_session_id != ids.viewer_session_id
            or scope.task_id != ids.task_id
            or scope.tool_session_id != ids.tool_session_id):
        raise NativeBrowserError("ownership")
    _, window, pane_vars, _, _, window_scope = _viewer(ids.viewer_session_id)
    if (scope.pane_vars != pane_vars or scope.window != window
            or scope.window_scope != window_scope):
        raise NativeBrowserError("ownership")
    return current


def _rpc_effect_fence(ctx, request, driver: BrowserDriver, action: str) -> None:
    """Reauthorize original live RPC and owner metadata before EACH native effect."""
    request.assert_attached()
    scope = driver.scope
    scope.require_caller(request)
    if not _native_tools_ready(ctx, scope.profile):
        raise PermissionError("native browser tool overrides absent or consent revoked; reload plugin")
    if _cdp_selected():
        raise NativeBrowserError("ownership")
    resolved = _legacy_identity(scope.rpc_session_id, scope.profile)
    if resolved is None:
        raise PermissionError("original browser task authority was replaced")
    owner, ids = resolved
    if (request.session_id != ids.rpc_session_id
            or scope.viewer_session_id != ids.viewer_session_id
            or scope.task_id != ids.task_id
            or scope.tool_session_id != ids.tool_session_id):
        raise PermissionError("original browser task authority was replaced")
    if action not in {"focus", "blocks"} and owner.get("running") is not False:
        raise NativeBrowserError("busy")


def _cdp_selected() -> bool:
    """The actual existing explicit CDP backend wins *before* native selection."""
    from tools.browser_tool_cdp import _get_cdp_override_raw

    return bool(_get_cdp_override_raw())


def _intent(ctx, action: str, request, params: dict) -> dict:
    profile = _profile(request)
    sid = request.session_id
    if params["session_id"] != sid:
        raise PermissionError("session reference does not match caller")
    existing = get_driver(profile, sid)
    if existing is not None:
        # Deny foreign mirrors BEFORE discovery, grant, or owner diagnostics.
        existing.scope.require_caller(request)
    resolved = _legacy_identity(sid, profile)
    if action == "blocks":
        # Read-only discovery is the sole lease-start path. A canonical request
        # without a trusted durable viewer identity cannot guess from its RPC SID.
        try:
            if _cdp_selected():
                return {"available": False, "blocks": [], "reason": "explicit_cdp"}
            if not callable(getattr(request, "capture_scope", None)):
                return {"available": False, "blocks": [], "reason": "caller_binding_unsupported"}
            if resolved is None:
                return {"available": False, "blocks": [], "reason": "task_authority_unavailable"}
            owner, ids = resolved
            ready = _native_tools_ready(ctx, profile)
            if ready and ids.tool_session_id and existing is not None:
                driver = _driver(request, ctx, require_owner=True)
                with effect_fence(lambda: _rpc_effect_fence(ctx, request, driver, "blocks")):
                    return {"available": True, "blocks": driver.listing()}

            reason = ("operator_consent_or_task_authority_required"
                      if not _consented(ctx) or not ids.tool_session_id
                      else "needs_plugin_reload")
            scope = _new_scope(request, profile, ids)
            kept = False
            try:
                can_start = bool(ready and ids.tool_session_id and owner.get("running") is False)
                if can_start and not callable(getattr(scope.lease, "assert_caller", None)):
                    can_start = False
                    reason = "caller_binding_unsupported"
                blocks = BrowserDriver(scope).listing()  # only CLI 'blocks', no claim/effect
                request.assert_attached()
                scope.require_current()
                if can_start:
                    if not _native_tools_ready(ctx, profile):
                        reason = "needs_plugin_reload"
                    elif _cdp_selected():
                        reason = "explicit_cdp"
                    elif (latest := _legacy_identity(sid, profile)) is None or (
                            latest[1] != ids or latest[0].get("running") is not False):
                        reason = "ownership"
                    else:
                        # The first RPC may record the original provisional
                        # lease AFTER read-only discovery. Successful dispatcher
                        # return grants it; no assert_caller on this provisional RPC.
                        register_driver(scope)
                        kept = True
                return {"available": kept, "blocks": blocks, **({} if kept else {"reason": reason})}
            finally:
                if not kept:
                    scope.lease.close()
        except NativeBrowserError as exc:
            if exc.kind == "ownership":
                raise
            return {"available": False, "blocks": [], "reason": exc.kind}

    if not _consented(ctx):
        raise PermissionError("native browser drive requires explicit tools.override consent")
    if resolved is None:
        raise PermissionError("original task and busy-turn authority unavailable")
    owner, ids = resolved
    if not ids.tool_session_id:
        raise NativeBrowserError("unsupported")
    if not _native_tools_ready(ctx, profile):
        raise PermissionError("native browser tool handlers absent; reload plugin after consent")
    if action in {"adopt", "release", "frame"} and owner.get("running") is not False:
        raise NativeBrowserError("busy")
    if _cdp_selected():
        # Never create an alternate claim while CDP is explicit.
        raise NativeBrowserError("ownership" if existing is not None else "unsupported")
    driver = _driver(request, ctx, require_owner=True)
    target = params["target_id"]

    with effect_fence(lambda: _rpc_effect_fence(ctx, request, driver, action)):
        _rpc_effect_fence(ctx, request, driver, action)
        if action == "adopt":
            result = driver.adopt(target)
        elif action == "focus":
            result = driver.focus(target)
        elif action == "release":
            result = driver.release(target)
        elif action == "frame":
            result = driver.select_frame(target, params["frame"])
        else:
            raise NativeBrowserError("invalid")
    request.assert_attached()
    driver.scope.require_caller(request)
    return result


def _rpc_handler(ctx, action: str) -> Callable:
    def handler(request, params: dict) -> dict:
        # Production gateway turns unexpected exceptions into generic,
        # non-credential-bearing JSON-RPC failures.
        return _intent(ctx, action, request, params)
    return handler


def _error(kind: str) -> str:
    return json.dumps({"success": False, "error_kind": kind,
                       "error": f"Native Tern browser {kind}; no other browser was selected"})


def _model_action(name: str, args: dict, driver: BrowserDriver) -> str | dict:
    """Run the same existing URL/JS policy as Hermes; no sidecar bypass."""
    from tools import browser_tool as browser

    def current_policy_error():
        current_url = driver.identity()["url"]
        _, secret = browser._secret_url_error_normalized(current_url)
        return secret or browser._url_policy_error(current_url, auto_local=False)

    if name != "browser_navigate":
        # The existing Hermes URL/website/secret policy also guards effects
        # and content on already selected pages (including eval navigations).
        blocked = current_policy_error()
        if blocked is not None:
            return json.dumps(blocked)
    if name == "browser_navigate":
        url = args.get("url")
        if not isinstance(url, str):
            return _error("invalid")
        url, error = browser._secret_url_error_normalized(url)
        if error is not None:
            return json.dumps(error)
        error = browser._url_policy_error(url, auto_local=False)
        if error is not None:
            return json.dumps(error)
        identity = driver.open(url)
        redirected = identity["url"]
        if browser._is_always_blocked_url(redirected) or browser._url_policy_error(
                redirected, auto_local=False) is not None:
            driver.close()
            return _error("invalid")
        snapshot = driver.command("snapshot")
        return json.dumps({
            "success": True, "url": redirected, "title": identity["title"],
            "snapshot": snapshot["data"]["snapshot"], "tern_target": identity,
        })
    ops = {
        "browser_snapshot": lambda: ("snapshot", ()),
        "browser_click": lambda: ("click", (args.get("ref"),)),
        "browser_type": lambda: ("fill", (args.get("ref"), args.get("text"))),
        "browser_scroll": lambda: ("scroll", (args.get("direction"),)),
        "browser_back": lambda: ("back", ()),
        "browser_press": lambda: ("press", (args.get("key"),)),
        "browser_get_images": lambda: ("eval", (browser._GET_IMAGES_JS,)),
    }
    if name == "browser_console":
        expr = args.get("expression")
        if args.get("clear") or not isinstance(expr, str):
            return _error("unsupported")
        blocked = browser._eval_policy._enforce_browser_eval_policy(expr)
        if blocked:
            return json.dumps({"success": False, "error": blocked})
        op, params = "eval", (expr,)
    elif name == "browser_vision":
        # Main-frame capture only. Return a real screenshot through the existing
        # vision result format, not fabricated console/annotation support.
        if args.get("annotate") is True:
            return _error("unsupported")
        if not isinstance(args.get("question"), str) or not args["question"].strip():
            return _error("invalid")
        image = driver.command("capture")
        blocked = current_policy_error()
        if blocked is not None:
            driver.close()
            return json.dumps(blocked)
        payload = image["data"].get("data")
        if not isinstance(payload, str):
            return _error("protocol")
        import base64
        import uuid
        from hermes_constants import get_hermes_dir

        path = get_hermes_dir("cache/screenshots", "browser_screenshots") / (
            f"browser_screenshot_{uuid.uuid4().hex}.png"
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(payload, validate=True))
        from tools.browser_tool_vision import _native_vision_result, _analyze_screenshot_with_aux_llm
        from tools.vision_tools import _should_use_native_vision_fast_path

        if _should_use_native_vision_fast_path():
            return _native_vision_result(path, args["question"], False, image, None)
        analysis = _analyze_screenshot_with_aux_llm(path, args["question"])
        return json.dumps({
            "success": True, "analysis": analysis or "Vision analysis returned no content.",
            "screenshot_path": str(path), "tern_target": image["tern_target"],
        })
    else:
        if name not in ops:
            return _error("unsupported")
        op, params = ops[name]()
    if not all(isinstance(p, str) for p in params):
        return _error("invalid")
    if name == "browser_scroll" and params[0] not in {"up", "down"}:
        return _error("invalid")
    if name == "browser_get_images" and driver.owned().frame != "main":
        return _error("unsupported")
    if op == "back":
        result = driver.command(op)
        final_url = result["data"]["url"]
        if browser._is_always_blocked_url(final_url) or browser._url_policy_error(
                final_url, auto_local=False) is not None:
            driver.close()
            return _error("invalid")
    else:
        result = driver.command(op, *params)
    blocked = current_policy_error()
    if blocked is not None:
        driver.close()
        return json.dumps(blocked)
    if name == "browser_snapshot":
        return json.dumps({
            "success": True, "snapshot": browser._snapshot._redact_browser_output(result["data"]["snapshot"]),
            "tern_target": result["tern_target"],
        })
    if name == "browser_get_images":
        raw_images = result["data"].get("result", "[]")
        try:
            images = json.loads(raw_images) if isinstance(raw_images, str) else raw_images
        except (TypeError, ValueError):
            return _error("protocol")
        if not isinstance(images, list):
            return _error("protocol")
        return json.dumps({
            "success": True, "images": browser._snapshot._redact_browser_output(images),
            "count": len(images),
            "tern_target": result["tern_target"],
        })
    if name == "browser_console":
        return json.dumps({
            "success": True, "result": browser._snapshot._redact_browser_output(result["data"].get("result")),
            "tern_target": result["tern_target"],
        })
    return json.dumps({
        "success": True, **{
            "url": result["data"].get("url"), "title": result["data"].get("title"),
        }, "tern_target": result["tern_target"],
    })


def _tool_handler(ctx, name: str, original: Callable) -> Callable:
    def handle(args, **kw):
        if not isinstance(args, dict):
            return _error("invalid")
        tool_sid, task_id = kw.get("session_id"), kw.get("task_id")
        if not isinstance(tool_sid, str) or not tool_sid or not isinstance(task_id, str) or not task_id:
            return _error("ownership")
        from gateway.session_authorities import served_profile_name
        from hermes_constants import get_hermes_home

        profile = served_profile_name(get_hermes_home())
        try:
            # Unique original claim indexed by its trusted task and its exact
            # built-agent tool SID, NEVER by a guessed live RPC/durable alias.
            driver = get_driver_for_tool(profile, tool_sid, task_id)
            if driver is not None:
                driver.scope.require_current()
                if not _native_tools_ready(ctx, profile):
                    return _error("unsupported")
                if _cdp_selected():
                    return _error("ownership")
                return _model_action(name, args, driver)
        except NativeBrowserError as exc:
            return _error(exc.kind)
        except (PermissionError, OSError, ValueError, TypeError, RuntimeError):
            logger.exception("native browser effect refused")
            return _error("failed")

        # No claim: retain the ORIGINAL tool for non-Tern/explicit CDP.
        # A live durable-keyed Tern pane must first commission via the bound
        # RPC; never silently let an unrelated browser take over its request.
        if _cdp_selected() or not tern_env.pane_env(tool_sid):
            return original(args, **kw)
        return _error("unsupported")

    return handle


def _native_availability(ctx, original_check: Callable | None) -> Callable:
    """Pure native capability check; preserve the existing non-native gate.

    A successful, caller-bound native discovery is the only way to enter the
    native branch. Checking this predicate does not call Tern, read a viewer
    marker, install Chromium or claim a page. The normal Hermes availability
    predicate remains authoritative outside supported native operation.
    """
    from tools.registry import no_cache_check_fn

    def check() -> bool:
        profile = ctx.profile_name
        if (_native_tools_ready(ctx, profile) and not _cdp_selected()
                and has_native_driver(profile)):
            return True
        return bool(original_check()) if original_check is not None else True

    return no_cache_check_fn(check)


def register(ctx) -> None:
    register_method = getattr(ctx, "register_gateway_method", None)
    if not callable(register_method):
        logger.info("Hermes gateway does not support plugin methods; native browser unavailable")
        return
    for action in METHODS:
        schema = BlocksParams if action == "blocks" else (
            FrameParams if action == "frame" else TargetParams
        )
        register_method(f"{PLUGIN}.browser.{action}", _rpc_handler(ctx, action), schema=schema)

    profile = ctx.profile_name
    ctx.on_unload(lambda: unload_profile(profile))
    if not _consented(ctx):
        logger.info("Native browser drive disabled; grant tools.override in this profile explicitly")
        return
    # The built-in handlers are preserved for explicit CDP or non-Tern calls.
    # Replacing through register_tool allows Hermes scope/pre-hook/guardrail
    # authorization to run BEFORE any native effect (never tool_execution middleware).
    from tools import browser_tool
    from tools.registry import registry

    handlers: dict[str, Callable] = {}
    for name in _TOOL_NAMES:
        entry = registry.get_entry(name)
        if entry is None:
            raise RuntimeError(f"Existing Hermes browser tool is missing: {name}")
        handler = _tool_handler(ctx, name, entry.handler)
        registration = ctx.register_tool(
            name=name, toolset=entry.toolset, schema=entry.schema,
            handler=handler,
            check_fn=_native_availability(ctx, entry.check_fn),
            requires_env=entry.requires_env,
            is_async=entry.is_async, description=entry.description,
            emoji=entry.emoji, override=True,
        )
        selected = registry.get_entry(name)
        if registration is None or selected is None or selected.handler is not handler:
            raise RuntimeError(f"Native browser override not installed: {name}")
        handlers[name] = handler
    with _NATIVE_LOCK:
        _NATIVE_HANDLERS[profile] = handlers
    ctx.on_unload(lambda: _forget_native_tools(profile, handlers))
