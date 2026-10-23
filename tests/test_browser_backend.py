"""Fail-closed browser RPC/provider checks with isolated caller transports/profiles.

The provider never treats a pane marker or a method name as operator consent.
The real green gateway dispatch integration is in test_browser_gateway_dispatch.py.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from hermes_tern_plugin import browser_backend as backend
from hermes_tern_plugin import browser_native as native
from hermes_tern_plugin.browser_transport import NativeBrowserError


@dataclass
class Lease:
    caller: object | None = None
    attached: bool = True
    closed: bool = False

    def assert_current(self):
        if not self.attached or self.closed:
            raise PermissionError("original transport, profile or generation detached")

    def assert_caller(self, current_request):
        self.assert_current()
        if current_request is not self.caller:
            raise PermissionError("not the original gateway caller")

    def close(self):
        self.closed = True


class Caller:
    def __init__(self, profile="work", sid="s1"):
        self.profile = profile
        self.session_id = sid
        self.lease = Lease(caller=self)
        self.attached = True
        self.captures = 0

    def assert_attached(self):
        if not self.attached:
            raise PermissionError("detached session")

    def capture_scope(self):
        self.assert_attached()
        self.captures += 1
        self.lease = Lease(caller=self)  # each RPC owns an independent, provisional lease
        return self.lease


class Context:
    profile_name = "work"

    def __init__(self, consent=False):
        self.consent = consent
        self.native_installed = False
        self.methods = {}
        self.tools = []
        self.cleanup = []

    def has_capability(self, capability):
        assert capability == "tools.override"
        return self.consent

    def register_gateway_method(self, name, handler, *, schema):
        self.methods[name] = (handler, schema)

    def register_tool(self, **data):
        self.tools.append(data)

    def on_unload(self, callback):
        self.cleanup.append(callback)


class Native:
    def __init__(self, *args):
        self.calls = []
        self.unknown = False
        self.fail_release = False
        self.pages = {
            7: {"block": 7, "title": "Personal", "url": "https://example.org/",
                "driven": False, "owner": None},
            8: {"block": 8, "title": "Foreign", "url": "https://foreign.example/",
                "driven": True, "owner": 55},
        }

    def __call__(self, op):
        self.calls.append(dict(op))
        if op["op"] == "blocks":
            return {"blocks": list(self.pages.values())}
        if op["op"] == "snapshot":
            return {"text": "snapshot"}
        if op["op"] == "release" and self.fail_release:
            raise NativeBrowserError("failed")
        if op["op"] == "open":
            self.pages[10] = {"block": 10, "title": "", "url": "about:blank",
                              "driven": True, "owner": op["owner"]}
            return {"block": 10}
        item = self.pages[op["block"]]
        if op["op"] == "goto":
            item["url"] = op["url"]
        if op["op"] == "close":
            del self.pages[op["block"]]
        if op["op"] == "eval":
            return {"value": "verified"}
        return dict(item)

    def invoke(self, argv):
        self.calls.append({"focus": argv})
        return {}

    def reconcile_open(self):
        raise NativeBrowserError("open_pending")


@pytest.fixture()
def system(monkeypatch):
    native._DRIVERS.clear()
    actor = Caller()
    ctx = Context()
    owner = {"session_key": "task-one", "agent": SimpleNamespace(session_id="tool-one"),
             "running": False, "profile_home": "/profiles/work"}
    clients = []

    monkeypatch.setattr(backend, "_profile", lambda req: req.profile if req.attached else req.assert_attached())
    monkeypatch.setattr(backend, "_legacy_owner", lambda sid, profile: owner if sid == "s1" and profile == "work" else None)
    monkeypatch.setattr(backend, "_cdp_selected", lambda: False)
    monkeypatch.setattr(backend, "_native_tools_ready",
                        lambda ctx, profile: ctx.consent and ctx.native_installed
                        and ctx.profile_name == profile)
    def durable_viewer(sid):
        assert sid == "task-one", "viewer lookup must use durable owner key"
        return (3, "window-1", (("TERN_PANE", "3"), ("TERN_WINDOW_KEY", "window-1")),
                {"PATH": "/bin"}, "tern", ("window-1", "daemon", "config"))
    monkeypatch.setattr(backend, "_viewer", durable_viewer)
    monkeypatch.setattr(backend, "TernBrowserCLI", lambda *a, **k: clients.append(Native()) or clients[-1])
    monkeypatch.setattr(native.BrowserScope, "require_current",
                        lambda self: self.lease.assert_current())
    yield ctx, actor, owner, clients
    native._DRIVERS.clear()


def request(action, actor, ctx, **rest):
    return backend._intent(ctx, action, actor, {"session_id": actor.session_id, **rest})


def test_schema_refuses_profile_parameters_and_nonexact_targets():
    with pytest.raises(ValidationError):
        backend.TargetParams.model_validate({
            "session_id": "s1", "profile": "other", "target_id": "7",
        }, strict=True)
    for target in ("", "07", "1.0", "x7"):
        with pytest.raises(ValidationError):
            backend.TargetParams.model_validate({
                "session_id": "s1", "target_id": target,
            }, strict=True)


def test_without_explicit_consent_discovery_stays_read_only(system):
    ctx, actor, owner, clients = system
    listing = request("blocks", actor, ctx)
    assert not listing["available"]
    assert listing["blocks"][0]["title"] == "Personal"
    assert listing["reason"] == "operator_consent_or_task_authority_required"
    assert clients[0].calls == [{"op": "blocks"}]
    with pytest.raises(PermissionError, match="explicit"):
        request("adopt", actor, ctx, target_id="7")
    assert clients[0].calls == [{"op": "blocks"}]


def test_granted_consent_adopts_and_revocation_fences_effects(system):
    ctx, actor, _, clients = system
    ctx.consent = True
    ctx.native_installed = True
    assert request("blocks", actor, ctx)["available"]
    assert native.get_driver("work", "s1") is not None
    identity = request("adopt", actor, ctx, target_id="7")
    assert identity["in_tern"] is True and identity["target_id"] == "7"
    client = clients[0]
    assert client.calls[0] == {"op": "blocks"}
    ctx.consent = False
    before = list(client.calls)
    assert request("blocks", actor, ctx) == {
        "available": False, "blocks": [],
        "reason": "operator_consent_or_task_authority_required",
    }
    assert len(clients) == 1 and client.calls == before
    with pytest.raises(PermissionError, match="explicit"):
        request("release", actor, ctx, target_id="7")
    with pytest.raises(PermissionError, match="explicit"):
        request("focus", actor, ctx, target_id="7")
    assert client.calls == before
    assert native.get_driver("work", "s1").owned().adopted


def test_consent_added_after_load_requires_reload_before_any_claim(system):
    ctx, actor, _, clients = system
    assert not request("blocks", actor, ctx)["available"]
    ctx.consent = True  # live grant, but the registration-time native overrides are absent
    found = request("blocks", actor, ctx)
    assert found["reason"] == "needs_plugin_reload"
    assert found["blocks"][0]["target_id"] == "7"
    assert native.get_driver("work", "s1") is None
    with pytest.raises(PermissionError, match="reload plugin"):
        request("adopt", actor, ctx, target_id="7")
    assert all(cli.calls == [{"op": "blocks"}] for cli in clients)

    ctx.native_installed = True  # models an explicitly granted plugin reload
    assert request("blocks", actor, ctx)["available"]
    installed = native.get_driver("work", "s1")
    assert installed is not None and installed.scope.lease is actor.lease
    assert request("adopt", actor, ctx, target_id="7")["target_id"] == "7"
    ctx.consent = False
    before = list(installed.scope.cli.calls)
    with pytest.raises(PermissionError, match="explicit"):
        request("focus", actor, ctx, target_id="7")
    assert installed.scope.cli.calls == before


def test_same_sid_mirror_cannot_reuse_or_effect_and_original_keeps_lease(system):
    ctx, actor, _, clients = system
    ctx.consent = True
    ctx.native_installed = True
    assert request("blocks", actor, ctx)["available"]
    driver = native.get_driver("work", "s1")
    original_lease = driver.scope.lease
    mirror = Caller(profile="work", sid="s1")  # attached peer and same legacy steer owner
    assert mirror.attached and mirror.session_id == actor.session_id
    before = list(driver.scope.cli.calls)
    for action, params in (
        ("blocks", {}),
        ("adopt", {"target_id": "7"}),
        ("focus", {"target_id": "7"}),
        ("release", {"target_id": "7"}),
        ("frame", {"target_id": "7", "frame": "main"}),
    ):
        with pytest.raises(PermissionError, match="original gateway caller"):
            request(action, mirror, ctx, **params)
    assert driver.scope.cli.calls == before
    assert native.get_driver("work", "s1").scope.lease is original_lease
    assert request("adopt", actor, ctx, target_id="7")["target_id"] == "7"
    assert native.get_driver("work", "s1").scope.lease is original_lease


def test_old_gateway_lease_without_public_caller_api_is_read_only(system, monkeypatch):
    ctx, actor, _, clients = system
    ctx.consent = True
    ctx.native_installed = True

    class OldLease:
        def assert_current(self):
            pass

        def close(self):
            self.closed = True

    legacy = OldLease()
    monkeypatch.setattr(actor, "capture_scope", lambda: legacy)
    result = request("blocks", actor, ctx)
    assert result["available"] is False
    assert result["reason"] == "caller_binding_unsupported"
    assert not native._DRIVERS
    assert legacy.closed
    assert clients[0].calls == [{"op": "blocks"}]
    with pytest.raises(NativeBrowserError, match="unsupported"):
        request("adopt", actor, ctx, target_id="7")
    assert clients[0].calls == [{"op": "blocks"}]


def test_old_gateway_without_capture_scope_refuses_before_native_read(system, monkeypatch):
    ctx, actor, _, clients = system
    ctx.consent = True
    ctx.native_installed = True
    monkeypatch.setattr(actor, "capture_scope", None)
    result = request("blocks", actor, ctx)
    assert result == {"available": False, "blocks": [], "reason": "caller_binding_unsupported"}
    assert clients == [] and not native._DRIVERS


def test_busy_turn_rejects_mutation_without_native_effect(system):
    ctx, actor, owner, clients = system
    ctx.consent = True
    ctx.native_installed = True
    request("blocks", actor, ctx)
    owner["running"] = True
    before = list(clients[0].calls)
    for action, extras in (
        ("adopt", {"target_id": "7"}),
        ("release", {"target_id": "7"}),
        ("frame", {"target_id": "7", "frame": "main"}),
    ):
        with pytest.raises(NativeBrowserError, match="busy"):
            request(action, actor, ctx, **extras)
    assert clients[0].calls == before


def test_refuses_original_task_replacement_session_and_profile(system):
    ctx, actor, owner, clients = system
    ctx.consent = True
    ctx.native_installed = True
    request("blocks", actor, ctx)
    owner["session_key"] = "replacement-task"
    with pytest.raises(NativeBrowserError, match="ownership"):
        request("adopt", actor, ctx, target_id="7")
    alien = Caller(profile="other", sid="s1")
    with pytest.raises(PermissionError, match="task"):
        request("adopt", alien, ctx, target_id="7")
    other_sid = Caller(profile="work", sid="s2")
    with pytest.raises(PermissionError, match="task"):
        request("adopt", other_sid, ctx, target_id="7")
    assert clients[0].calls == [{"op": "blocks"}]


def test_original_transport_or_generation_detach_not_redirected(system):
    ctx, actor, owner, clients = system
    ctx.consent = True
    ctx.native_installed = True
    request("blocks", actor, ctx)
    request("adopt", actor, ctx, target_id="7")
    actor.lease.attached = False
    new_actor = Caller(profile="work", sid="s1")
    before = list(clients[0].calls)
    with pytest.raises(PermissionError, match="detached"):
        request("focus", new_actor, ctx, target_id="7")
    assert clients[0].calls == before
    assert native.get_driver("work", "s1") is not None


def test_canonical_without_task_busy_accessor_lists_but_denies_drive(system, monkeypatch):
    ctx, actor, owner, clients = system
    ctx.consent = True
    ctx.native_installed = True
    owner.clear()
    # Scope this temporary canonical simulation to its own fixture. Leaving
    # the real legacy accessor overwritten contaminates later dispatcher tests.
    monkeypatch.setattr(backend, "_legacy_owner", lambda sid, profile: None)
    listing = request("blocks", actor, ctx)
    assert not listing["available"]
    assert listing == {"available": False, "blocks": [],
                       "reason": "task_authority_unavailable"}
    assert not clients and not native._DRIVERS
    with pytest.raises(PermissionError, match="task"):
        request("adopt", actor, ctx, target_id="7")


def test_explicit_cdp_wins_before_any_browser_discovery(system, monkeypatch):
    ctx, actor, _, clients = system
    ctx.consent = True
    ctx.native_installed = True
    monkeypatch.setattr(backend, "_cdp_selected", lambda: True)
    assert request("blocks", actor, ctx) == {
        "available": False, "blocks": [], "reason": "explicit_cdp",
    }
    assert clients == [] and not native._DRIVERS


def test_native_backend_errors_are_secret_safe():
    raw = backend._error("ownership")
    assert json.loads(raw) == {
        "success": False,
        "error_kind": "ownership",
        "error": "Native Tern browser ownership; no other browser was selected",
    }
    assert "token=" not in raw and "https://" not in raw


def test_true_id_domains_and_unbuilt_agent_read_only(system):
    ctx, actor, owner, clients = system
    ctx.consent = ctx.native_installed = True
    assert backend._legacy_identity("s1", "work")[1] == backend.LegacyIdentity(
        rpc_session_id="s1", viewer_session_id="task-one",
        task_id="task-one", tool_session_id="tool-one",
    )
    assert request("blocks", actor, ctx)["available"]
    driver = native.get_driver("work", "s1")
    assert driver.scope.rpc_session_id == "s1"
    assert driver.scope.viewer_session_id == "task-one"
    assert driver.scope.tool_session_id == "tool-one"
    assert native.get_driver("work", "task-one") is None
    assert native.get_driver_for_tool("work", "tool-one", "task-one") is driver
    with pytest.raises(NativeBrowserError, match="ownership"):
        native.get_driver_for_tool("work", "s1", "task-one")

    native._DRIVERS.clear()
    owner["agent"] = None
    listing = request("blocks", actor, ctx)
    assert not listing["available"]
    assert listing["blocks"][0]["target_id"] == "7"
    assert native.get_driver("work", "s1") is None
