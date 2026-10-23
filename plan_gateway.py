"""Fail-closed Tern plan RPC contract at the public Hermes plugin seam.

This is deliberately *not* a plan engine. The current public gateway context
attests an attached caller, but does not attest accepted-turn identity, busy
state, durable owner task, successful terminal outcome, or either execution
policy boundary. Exposing editable/approvable plans without all of those would
make an inspection UI an unsafe authorization interface.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool

NAMESPACE = "hermes-tern.plan"
AUTHORITY_REQUIRED = (
    "Hermes plan review needs public accepted-turn identity, live busy/owner "
    "and generation authority, terminal completion, both execution-boundary "
    "planning policy, and exact reviewed bytes at next user-turn admission. "
    "The plugin gateway method seam alone does not provide these contracts."
)


class SessionParams(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    session_id: str = Field(min_length=1)


class ModeParams(SessionParams):
    enabled: StrictBool


class TargetParams(SessionParams):
    plan_id: str = Field(min_length=1)
    revision: int = Field(ge=1, strict=True)


class EditParams(TargetParams):
    text: str = Field(min_length=1, max_length=200000)


class AnnotateParams(TargetParams):
    section: int = Field(ge=0, strict=True)
    text: str = Field(max_length=16000)


class DecideParams(TargetParams):
    intent: Literal["approve", "refine"]
    feedback: str = Field(default="", max_length=16000)


def status(request, _params: dict) -> dict:
    """Machine-readable unsupported status; never synthesize a successful plan."""
    request.assert_attached()
    return {"supported": False, "reason": AUTHORITY_REQUIRED}


def refuse_mutation(request, _params: dict) -> dict:
    """Even a valid attached editor cannot mutate without runtime policy authority."""
    request.assert_attached()
    from hermes_cli.plugin_gateway_methods import GatewayMethodFailure

    raise GatewayMethodFailure(4094, AUTHORITY_REQUIRED)


def register(ctx) -> None:
    """Advertise an explicit guarded boundary only on compatible Hermes cores.

    Older Hermes plugin managers have no register_gateway_method. Their Tern UI
    discovers the missing method inventory and explains the required upgrade.
    """
    register_method = getattr(ctx, "register_gateway_method", None)
    if register_method is None:
        return

    for verb, handler, schema in (
        ("status", status, SessionParams),
        ("mode", refuse_mutation, ModeParams),
        ("edit", refuse_mutation, EditParams),
        ("annotate", refuse_mutation, AnnotateParams),
        ("decide", refuse_mutation, DecideParams),
    ):
        register_method(f"{NAMESPACE}.{verb}", handler, schema=schema)
