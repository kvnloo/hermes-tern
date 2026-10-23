"""Hermes-tern browser gateway ownership and consented, policy-routed tool adapter.

No core patches, alternate RPC router or middleware executor: all model actions
enter Hermes through PluginContext.register_tool(override=True). The legacy
gateway's *existing* steer-authority observation supplies its task and busy
fence; a canonical gateway without an equivalent public task/busy projection
may list pages but cannot grant drive permission.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict, Field

from . import tern_env
from .browser_native import (
    BrowserDriver, BrowserScope, NativeBrowserError, TernBrowserCLI,
    effect_fence, get_driver, register_driver, unload_profile,
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


def _driver(request, ctx, *, require_owner: bool) -> BrowserDriver:
    profile = _profile(request)
    sid = request.session_id
    owner = _legacy_owner(sid, profile)
    if require_owner and owner is None:
        raise NativeBrowserError("unavailable")
    pane, window, pane_vars, env, executable, window_scope = _viewer(sid)
    current = get_driver(profile, sid)
    if current is not None:
        scope = current.scope
        scope.require_current()  # does not follow a newer viewer/connection
        if (scope.pane_vars != pane_vars or scope.window != window
                or scope.window_scope != window_scope
                or (owner is not None and owner.get("session_key") != scope.task_id)):
            raise NativeBrowserError("ownership")
        return current
    if owner is None:
        raise NativeBrowserError("unavailable")
    if not _consented(ctx):
        raise NativeBrowserError("unsupported")
    # Only a successfully returned registered RPC can mint a durable,
    # caller/transport/profile/session-generation-bound publisher.
    lease = request.capture_scope()
    scope = BrowserScope(
        profile=profile, session_id=sid, task_id=owner["session_key"],
        pane_vars=pane_vars, pane=pane, window=window,
        window_scope=window_scope, lease=lease,
        cli=TernBrowserCLI(executable, env, window),
    )
    try:
        return register_driver(scope)
    except Exception:
        lease.close()
        raise


def _cdp_selected() -> bool:
    """The actual existing explicit CDP backend wins *before* native selection."""
    from tools.browser_tool_cdp import _get_cdp_override_raw

    return bool(_get_cdp_override_raw())


def _intent(ctx, action: str, request, params: dict) -> dict:
    profile = _profile(request)
    sid = request.session_id
    if params["session_id"] != sid:
        raise PermissionError("session reference does not match caller")
    if action == "blocks":
        # Discovery stays read-only without override consent, and never converts
        # an unrelated canonical subscription into a task-owner authority.
        try:
            if _cdp_selected():
                return {"available": False, "blocks": [], "reason": "explicit_cdp"}
            owner = _legacy_owner(sid, profile)
            if owner is None or not _consented(ctx):
                # No durable driver is stored: listing is not a drive grant.
                pane, window, variables, env, exe, scope_key = _viewer(sid)
                lease = request.capture_scope()
                try:
                    scope = BrowserScope(
                        profile, sid, sid, variables, pane, window, scope_key,
                        lease, TernBrowserCLI(exe, env, window),
                    )
                    return {"available": False, "blocks": BrowserDriver(scope).listing(),
                            "reason": "operator_consent_or_task_authority_required"}
                finally:
                    lease.close()
            driver = _driver(request, ctx, require_owner=True)
            return {"available": True, "blocks": driver.listing()}
        except NativeBrowserError as exc:
            if exc.kind == "ownership":
                raise
            return {"available": False, "blocks": [], "reason": exc.kind}

    if not _consented(ctx):
        raise PermissionError("native browser drive requires explicit tools.override consent")
    owner = _legacy_owner(sid, profile)
    if owner is None:
        raise PermissionError("original task and busy-turn authority unavailable")
    if action in {"adopt", "release", "frame"} and owner.get("running") is not False:
        raise NativeBrowserError("busy")
    if _cdp_selected():
        # Do not create even an idle native claim while CDP is explicit.
        existing = get_driver(profile, sid)
        raise NativeBrowserError("ownership" if existing is not None else "unsupported")
    driver = _driver(request, ctx, require_owner=True)
    target = params["target_id"]

    def original_task_fence() -> None:
        request.assert_attached()
        driver.scope.require_current()
        current = _legacy_owner(sid, profile)
        if current is None or current.get("session_key") != driver.scope.task_id:
            raise PermissionError("original browser task authority was replaced")
        if action != "focus" and current.get("running") is not False:
            raise NativeBrowserError("busy")

    with effect_fence(original_task_fence):
        original_task_fence()
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
    driver.scope.require_current()
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
    if name == "browser_snapshot":
        return json.dumps({
            "success": True, "snapshot": result["data"]["snapshot"],
            "tern_target": result["tern_target"],
        })
    if name == "browser_get_images":
        return json.dumps({
            "success": True, "images": result["data"].get("result"),
            "tern_target": result["tern_target"],
        })
    if name == "browser_console":
        return json.dumps({
            "success": True, "result": result["data"].get("result"),
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
        sid = kw.get("session_id")
        if not isinstance(sid, str) or not sid:
            return _error("ownership")
        from gateway.session_authorities import served_profile_name
        from hermes_constants import get_hermes_home

        profile = served_profile_name(get_hermes_home())
        driver = get_driver(profile, sid)
        # A claimed native session is irreversible until explicit cleanup.
        if driver is not None:
            try:
                driver.scope.require_current()
                if kw.get("task_id") != driver.scope.task_id:
                    return _error("ownership")
                if not _consented(ctx):
                    return _error("unsupported")
                if _cdp_selected():
                    return _error("ownership")
                return _model_action(name, args, driver)
            except NativeBrowserError as exc:
                return _error(exc.kind)
            except (OSError, ValueError, TypeError, RuntimeError):
                logger.exception("native browser effect refused")
                return _error("failed")

        # No native claim: an explicitly selected CDP backend wins. Outside a
        # live Tern viewer, the existing browser implementation stays intact.
        if _cdp_selected() or not tern_env.pane_env(sid):
            return original(args, **kw)
        return _error("unsupported")  # discover through a caller-bound RPC first

    return handle


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

    for name in _TOOL_NAMES:
        entry = registry.get_entry(name)
        if entry is None:
            raise RuntimeError(f"Existing Hermes browser tool is missing: {name}")
        ctx.register_tool(
            name=name, toolset=entry.toolset, schema=entry.schema,
            handler=_tool_handler(ctx, name, entry.handler),
            check_fn=entry.check_fn, requires_env=entry.requires_env,
            is_async=entry.is_async, description=entry.description,
            emoji=entry.emoji, override=True,
        )
