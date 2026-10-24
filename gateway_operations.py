"""Profile-scoped read-only operational reports over public Hermes APIs only.

The gateway owns session admission. This plugin never selects a transport,
opens a connection, executes an SSH command or reads credentials.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


View = Literal["mcp-list", "mcp-status", "mcp-tools", "mcp-catalog", "ssh-list"]


class ReportParams(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    session_id: str = Field(min_length=1)
    view: View


_MESSAGES = {
    "mcp-list": "Configured MCP servers in the attached Hermes profile; credentials and arguments withheld.",
    "mcp-status": "Cached Hermes MCP status only; no connection or probe was attempted.",
    "mcp-catalog": "Hermes MCP catalog names and installed/enabled state; no install attempted.",
    "mcp-tools": "Cached tool-name ownership is unavailable through the public plugin API; no connection attempted.",
    "ssh-list": "Effective SSH target ownership is unavailable through the public plugin API; no connection attempted.",
}
_FAILURE = "Hermes read-only inventory is unavailable; no connection or mutation was attempted."
_STATES = frozenset({"connected", "disabled", "connecting", "failed", "lazy", "configured"})


def _servers() -> dict[str, dict]:
    from hermes_cli.config import load_config_readonly

    configured = load_config_readonly().get("mcp_servers")
    if not isinstance(configured, dict):
        return {}
    return {name: cfg for name, cfg in configured.items()
            if isinstance(name, str) and isinstance(cfg, dict)}


def _list(configured: dict[str, dict]) -> list[dict]:
    from tools.mcp_tool_common import mcp_server_enabled

    rows = []
    for name, cfg in sorted(configured.items()):
        auth = ("OAuth configured (values withheld)" if cfg.get("auth") == "oauth" else
                "Headers configured (values withheld)" if cfg.get("headers") else
                "Environment configured (values withheld)" if cfg.get("env") else
                "Authentication configured (details withheld)" if cfg.get("auth") else
                "No explicit authentication configured")
        rows.append({"name": name, "details": [
            "HTTP" if cfg.get("url") else "stdio" if cfg.get("command") else "unknown transport",
            "enabled" if mcp_server_enabled(cfg) else "disabled",
            auth,
        ]})
    return rows


def _status(configured: dict[str, dict]) -> list[dict]:
    from tools.mcp_tool_discovery import get_mcp_status

    # This public reader filters cached connections by the active profile
    # scope. Never read its private registry or export its raw error field.
    rows = []
    for item in get_mcp_status(configured, include_runtime=True):
        name, state, count = item.get("name"), item.get("status"), item.get("tools")
        if (not isinstance(name, str) or state not in _STATES
                or type(count) is not int or count < 0):
            raise ValueError("invalid MCP cached status")
        rows.append({"name": name, "details": [state, f"{count} cached tools"]})
    return rows


def _catalog() -> list[dict]:
    from hermes_cli import mcp_catalog

    return [{"name": entry.name, "details": [
        "installed" if mcp_catalog.is_installed(entry.name) else "not installed",
        "enabled" if mcp_catalog.is_enabled(entry.name) else "disabled",
    ]} for entry in mcp_catalog.list_catalog()]


def report(request, params: dict) -> dict:
    """Live RPC SID is transport authority, NOT durable or agent/tool session ID."""
    request.assert_attached()
    if params.get("session_id") != request.session_id:
        raise PermissionError("requires the original attached live RPC session")

    view = params["view"]
    result = {"view": view, "scope": request.profile, "state": "ready",
              "read_only": True, "rows": [], "message": _MESSAGES[view]}
    if view in ("mcp-tools", "ssh-list"):
        # Never mislabel a missing public ledger/SSH authority as an empty list.
        result["state"] = "unavailable"
        request.assert_attached()
        return result

    try:
        result["rows"] = (_catalog() if view == "mcp-catalog" else
                          _list(_servers()) if view == "mcp-list" else
                          _status(_servers()))
    except Exception:
        # Source exceptions may contain URLs, headers, env values and keys.
        result.update(state="unavailable", rows=[], message=_FAILURE)
    request.assert_attached()
    return result


def register(ctx) -> None:
    ctx.register_gateway_method("hermes-tern.operations.report", report, schema=ReportParams)
