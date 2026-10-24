"""On-disk, isolated profile receipts for read-only Hermes gateway operations."""
from __future__ import annotations

from pathlib import Path

import hermes_yaml as yaml
import pytest

from hermes_cli.plugin_gateway_methods import GatewayRequestContext
from hermes_tern_plugin import gateway_operations as ops


@pytest.fixture
def disk_profile(tmp_path, monkeypatch):
    home = tmp_path / "owned-profile"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    import hermes_cli.config as config
    monkeypatch.setattr(config, "get_hermes_home", lambda: home)
    monkeypatch.setattr(config, "get_config_path", lambda: home / "config.yaml")
    path = home / "config.yaml"
    path.write_text(yaml.safe_dump({"mcp_servers": {
        "my-mcp": {"url": "https://secret.example/mcp",
                   "headers": {"Authorization": "Bearer private-value"},
                   "env": {"TOKEN": "fixture-secret"}, "enabled": True},
        "off-mcp": {"command": "echo", "args": ["private-arg"], "enabled": False},
    }}), encoding="utf-8")
    return path


def _request(*, attached=True, sid="live-rpc-a"):
    return GatewayRequestContext(
        session_id=sid, profile="owned-profile", _attached=lambda: attached,
    )


def test_registration_names_only_actual_public_supported_method():
    class Recorder:
        def __init__(self):
            self.registrations = []

        def register_gateway_method(self, name, handler, *, schema):
            self.registrations.append((name, handler, schema))

    ctx = Recorder()
    ops.register(ctx)
    assert ctx.registrations == [
        ("hermes-tern.operations.report", ops.report, ops.ReportParams)
    ]
    with pytest.raises(Exception):
        ops.ReportParams.model_validate({"session_id": "live-rpc-a",
                                         "view": "mcp-list", "profile": "foreign"})


def test_real_profile_list_redacts_values_without_writing(disk_profile: Path):
    before = disk_profile.read_bytes()
    r = ops.report(_request(), {"session_id": "live-rpc-a", "view": "mcp-list"})
    assert r["state"] == "ready" and r["read_only"] is True
    assert r["scope"] == "owned-profile"
    assert [row["name"] for row in r["rows"]] == ["my-mcp", "off-mcp"]
    assert r["rows"][0]["details"][:2] == ["HTTP", "enabled"]
    assert r["rows"][1]["details"][:2] == ["stdio", "disabled"]
    for forbidden in ("secret.example", "Bearer", "private-value", "fixture-secret",
                      "private-arg", "Authorization"):
        assert forbidden not in str(r)
    assert disk_profile.read_bytes() == before


def test_public_cached_connection_ledger_does_not_probe(disk_profile, monkeypatch):
    import tools.mcp_tool_discovery as discovery

    before = disk_profile.read_bytes()
    monkeypatch.setattr(discovery, "discover_mcp_tools",
                        lambda *a, **k: pytest.fail("unexpected discovery"))
    monkeypatch.setattr(discovery, "register_mcp_servers",
                        lambda *a, **k: pytest.fail("unexpected connection"))
    r = ops.report(_request(), {"session_id": "live-rpc-a", "view": "mcp-status"})
    assert r["state"] == "ready"
    assert r["rows"] == [
        {"name": "my-mcp", "details": ["configured", "0 cached tools"]},
        {"name": "off-mcp", "details": ["disabled", "0 cached tools"]},
    ]
    assert disk_profile.read_bytes() == before


@pytest.mark.parametrize("view", ["mcp-tools", "ssh-list"])
def test_no_public_owner_ledger_is_explicit_unavailable(disk_profile, view):
    r = ops.report(_request(), {"session_id": "live-rpc-a", "view": view})
    assert r["state"] == "unavailable" and r["rows"] == []
    assert "unavailable" in r["message"]


def test_mismatched_live_sid_never_reads_private_config(disk_profile, monkeypatch):
    import hermes_cli.config as config
    monkeypatch.setattr(config, "load_config_readonly",
                        lambda: pytest.fail("private profile read"))
    with pytest.raises(PermissionError):
        ops.report(_request(), {"session_id": "foreign", "view": "mcp-list"})


def test_revoked_attachment_is_rejected(disk_profile):
    with pytest.raises(PermissionError):
        ops.report(_request(attached=False), {"session_id": "live-rpc-a", "view": "mcp-list"})


def test_failures_redact_exception_text(disk_profile, monkeypatch):
    monkeypatch.setattr(ops, "_servers", lambda: (_ for _ in ()).throw(
        RuntimeError("Bearer private-value https://secret.example")
    ))
    r = ops.report(_request(), {"session_id": "live-rpc-a", "view": "mcp-list"})
    assert r["state"] == "unavailable" and r["rows"] == []
    assert "private-value" not in str(r) and "secret.example" not in str(r)
