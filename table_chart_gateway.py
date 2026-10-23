"""Trusted in-process table gateway methods for the green Hermes plugin seam.

Not imported by the plugin root yet. Registration is the separate serialized
wiring step; importing this module does not register anything.
"""
from __future__ import annotations

import contextvars
import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from hermes_constants import get_hermes_home
from pydantic import BaseModel, ConfigDict, Field

from .table_chart_planner import DEADLINE_SECONDS, TablePlanningUnsupported, _single_attempt, eligible

if TYPE_CHECKING:
    from hermes_cli.plugins import PluginContext

POLICY_METHOD = "hermes-tern.table.policy"
PLAN_METHOD = "hermes-tern.table.plan"


class PolicyParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(min_length=1)


class PlanParams(PolicyParams):
    source: str = Field(min_length=1, max_length=8192)


def _owner_mode() -> str:
    """Read the *current authoritative profile's* existing frontend policy.

    Canonical and legacy plugin dispatch establish their profile runtime scope.
    Never interpret a client-supplied profile, policy, or settings path.
    """
    file = Path(get_hermes_home()) / "hermes-tern" / "settings.json"
    try:
        with file.open("rb") as source:
            raw = source.read(16385)
        if len(raw) > 16384:
            return "off"
        stored = json.loads(raw)
    except (OSError, ValueError, UnicodeError):
        return "off"
    mode = stored.get("tableCharts") if isinstance(stored, dict) else None
    return mode if mode in ("off", "always", "smart") else "off"


@dataclass
class _Budget:
    attempts: int = 0
    active: bool = False


def register(ctx: PluginContext) -> None:
    """Attach only real, profile-owned, synchronous gateway methods.

    A core predating ba42's public gateway registrar is unsupported. No
    guessed session RPC or private authorization/owner access is attempted.
    """
    registrar = getattr(ctx, "register_gateway_method", None)
    on_unload = getattr(ctx, "on_unload", None)
    if not callable(registrar) or not callable(on_unload):
        raise RuntimeError("Hermes plugin gateway methods require core ba42d324 / PR #650")

    lock = threading.Lock()
    budgets: dict[tuple[str, str], _Budget] = {}
    unloaded = threading.Event()

    def owned(request, params: dict) -> None:
        request.assert_attached()
        if params["session_id"] != request.session_id or unloaded.is_set():
            raise PermissionError("not the attached runtime")

    def policy(request, params: dict) -> dict:
        owned(request, params)
        return {"mode": _owner_mode()}

    def plan(request, params: dict) -> dict:
        owned(request, params)
        deadline = time.monotonic() + DEADLINE_SECONDS
        if _owner_mode() != "smart" or not eligible(params["source"]):
            return {"kind": "bar"}
        # These strings are usable as grouping labels ONLY AFTER original-transport
        # admission above. They are not bearer capabilities. A stable runtime-owner
        # generation is not exported by the ba42 public request API, so counters
        # deliberately never refill on same-id reconnect/reuse during registration
        # lifetime; no completed chart decision is cached across requests.
        key = (request.profile, request.session_id)
        with lock:
            state = budgets.setdefault(key, _Budget())
            if unloaded.is_set() or state.active or state.attempts >= 8:
                return {"kind": "bar"}
            state.active = True

        try:
            lease = request.capture_scope()
        except BaseException:
            with lock:
                state.active = False
            raise

        done = threading.Event()
        outcome: dict[str, str] = {"kind": "bar"}
        scope = contextvars.copy_context()

        def work() -> None:
            try:
                def current() -> bool:
                    if unloaded.is_set() or time.monotonic() >= deadline:
                        return False
                    lease.assert_current()
                    return _owner_mode() == "smart"

                def charge() -> None:
                    if not current():
                        raise PermissionError("table ownership or policy revoked")
                    with lock:
                        if unloaded.is_set() or state.attempts >= 8:
                            raise PermissionError("table attempt budget exhausted")
                        state.attempts += 1

                kind = _single_attempt(
                    params["source"], deadline=deadline,
                    before_send=charge, still_current=current,
                )
                if current():
                    outcome["kind"] = kind
            except (TablePlanningUnsupported, ImportError):
                outcome["status"] = "unsupported"
            except BaseException:
                outcome["kind"] = "bar"
            finally:
                # A timed-out/removed request may still have a provider on the
                # wire: only its actual worker settlement releases active.
                with lock:
                    state.active = False
                try:
                    lease.close()
                finally:
                    done.set()

        try:
            threading.Thread(target=scope.run, args=(work,), daemon=True,
                             name="tern-table-gateway").start()
        except BaseException:
            with lock:
                state.active = False
            lease.close()
            raise

        if not done.wait(max(0, deadline - time.monotonic())):
            return {"kind": "bar"}
        owned(request, params)
        if _owner_mode() != "smart":
            return {"kind": "bar"}
        if outcome.get("status") == "unsupported":
            return {"status": "unsupported", "reason": "table_provider_unavailable"}
        return {"kind": outcome["kind"]}

    ctx.register_gateway_method(POLICY_METHOD, policy, schema=PolicyParams)
    ctx.register_gateway_method(PLAN_METHOD, plan, schema=PlanParams)
    ctx.on_unload(unloaded.set)
