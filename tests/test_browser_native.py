"""Native browser ownership tests. Synthetic native protocol, no real panes.

Every state-mutating test uses an isolated fake transport; neither a personal
profile nor a real browser is touched. Native Sway smoke is a separate gate.
"""
from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

import pytest

from hermes_tern_plugin import browser_native as native
from hermes_tern_plugin.browser_transport import NativeBrowserError


class FakeLease:
    def __init__(self):
        self.current = True
        self.closed = False

    def assert_current(self):
        if not self.current or self.closed:
            raise PermissionError("detached generation")

    def close(self):
        self.closed = True


class FakeCLI:
    def __init__(self):
        self.calls = []
        self.entries = {
            7: {"block": 7, "title": "User page", "url": "https://example.org",
                "owner": None, "driven": False},
            9: {"block": 9, "title": "Other pane", "url": "https://foreign.example",
                "owner": 88, "driven": True},
        }
        self.unknown = False
        self.fail_release = False
        self.late = None

    def __call__(self, op):
        self.calls.append(dict(op))
        verb = op["op"]
        if verb == "blocks":
            return {"blocks": [dict(item) for item in self.entries.values()]}
        if verb == "open":
            self.entries[10] = {
                "block": 10, "title": "", "url": "about:blank",
                "owner": op["owner"], "driven": True,
            }
            return {"block": 10}
        if verb == "release" and self.fail_release:
            raise NativeBrowserError("unavailable")
        entry = self.entries[op["block"]]
        if verb == "goto":
            entry["url"] = op["url"]
        if verb == "close":
            del self.entries[op["block"]]
        if verb == "snapshot":
            return {"text": '- button "Continue" [ref=e1]'}
        if verb == "eval":
            return {"value": 42}
        return dict(entry)

    def invoke(self, argv):
        self.calls.append({"focus": argv})
        return {}

    def reconcile_open(self):
        if self.late is None:
            raise NativeBrowserError("open_pending")
        return self.late


@pytest.fixture
def rig(monkeypatch):
    native._DRIVERS.clear()
    cli = FakeCLI()
    lease = FakeLease()
    scope = native.BrowserScope(
        profile="work", rpc_session_id="s1", viewer_session_id="task-one",
        task_id="task-one", tool_session_id="tool-one",
        pane_vars=(("TERN_PANE", "3"), ("TERN_WINDOW_KEY", "w1")),
        pane=3, window="w1", window_scope=("w1", "sock", "config"),
        lease=lease, cli=cli,
    )
    # Isolate the provider protocol from Hermes' profile runtime. The real
    # lease/profile enforcement is tested separately in test_browser_backend.py.
    monkeypatch.setattr(native.BrowserScope, "require_current",
                        lambda self: self.lease.assert_current())
    driver = native.register_driver(scope)
    yield driver, cli, lease
    native._DRIVERS.clear()


def test_discovery_does_not_adopt_or_grant_drive(rig):
    driver, cli, _ = rig
    blocks = driver.listing()
    assert blocks[0] == {
        "target_id": "7", "title": "User page", "url": "https://example.org",
        "owner": None, "owned": False, "available": True,
    }
    with pytest.raises(NativeBrowserError, match="ownership"):
        driver.command("click", "@e1")
    assert [item["op"] for item in cli.calls] == ["blocks"]


def test_foreign_driven_block_cannot_be_adopted(rig):
    driver, cli, _ = rig
    with pytest.raises(NativeBrowserError, match="ownership"):
        driver.adopt("9")
    assert not any(item.get("op") == "snapshot" for item in cli.calls)


@pytest.mark.parametrize("chosen", ["", "07", "+7", " 7", "7x", 7, True])
def test_exact_block_id_validation_before_side_effect(rig, chosen):
    driver, cli, _ = rig
    with pytest.raises(NativeBrowserError, match="invalid"):
        driver.adopt(chosen)
    assert cli.calls == []


def test_handover_releases_page_and_keeps_it_open(rig):
    driver, cli, _ = rig
    assert driver.adopt("7")["target_id"] == "7"
    assert driver.owned("7").adopted
    driver.focus("7")
    assert cli.calls[-2]["focus"] == ["focus", "7", "--json"]
    assert driver.release("7") == {"target_id": "7", "released": True}
    assert {"op": "release", "block": 7} in cli.calls
    assert not any(item.get("op") == "close" and item.get("block") == 7 for item in cli.calls)
    assert 7 in cli.entries and driver.target is None


def test_agent_created_page_closed_on_release(rig):
    driver, cli, _ = rig
    assert driver.open("https://example.net")["target_id"] == "10"
    assert not driver.owned().adopted
    assert cli.calls[0] == {"op": "open", "owner": 3, "url": "about:blank"}
    assert driver.release("10")["released"]
    assert {"op": "close", "block": 10} in cli.calls
    assert 7 in cli.entries and 10 not in cli.entries


def test_failed_cleanup_retains_original_claim(rig):
    driver, cli, _ = rig
    driver.adopt("7")
    cli.fail_release = True
    with pytest.raises(NativeBrowserError, match="unavailable"):
        driver.release("7")
    assert driver.owned("7").adopted
    cli.fail_release = False
    driver.release("7")
    assert driver.target is None


def test_cross_profile_same_window_cannot_steal_block(rig):
    driver, cli, _ = rig
    driver.adopt("7")
    peer_scope = native.BrowserScope(
        profile="other", rpc_session_id="s2", viewer_session_id="other-task",
        task_id="other-task", tool_session_id="other-tool",
        pane_vars=driver.scope.pane_vars, pane=99, window="w1",
        window_scope=driver.scope.window_scope, lease=FakeLease(), cli=cli,
    )
    peer = native.register_driver(peer_scope)
    assert not peer.listing()[0]["available"]
    with pytest.raises(NativeBrowserError, match="ownership"):
        peer.adopt("7")
    assert driver.owned("7").block == 7


@pytest.mark.parametrize("frame", ["00", " 0", "+0", "0.", "1..0", "Main", 0, None])
def test_invalid_frames_do_not_evaluate(rig, frame):
    driver, cli, _ = rig
    driver.adopt("7")
    before = len(cli.calls)
    with pytest.raises(NativeBrowserError, match="invalid"):
        driver.select_frame("7", frame)
    assert len(cli.calls) == before


def test_child_frame_is_evaluation_only(rig):
    driver, cli, _ = rig
    driver.adopt("7")
    result = driver.select_frame("7", "1.0")
    assert result["frame"] == "1.0"
    assert cli.calls[-2]["op"] == "eval"
    assert cli.calls[-2]["frame"] == "1.0"
    before = len(cli.calls)
    for action in ("snapshot", "click", "capture", "back"):
        with pytest.raises(NativeBrowserError, match="unsupported"):
            driver.command(action, "@e1")
    with pytest.raises(NativeBrowserError, match="unsupported"):
        driver.open("https://example.net")
    assert len(cli.calls) == before
    assert driver.command("eval", "6*7")["data"]["result"] == 42
    assert cli.calls[-2]["frame"] == "1.0"


def test_detached_lease_fences_all_native_effects(rig):
    driver, cli, lease = rig
    driver.adopt("7")
    before = list(cli.calls)
    lease.current = False
    with pytest.raises(PermissionError):
        driver.focus("7")
    with pytest.raises(PermissionError):
        driver.command("click", "@e1")
    with pytest.raises(PermissionError):
        driver.release("7")
    assert cli.calls == before
    assert driver.target is not None


def test_unload_defers_revoked_original_lease_without_losing_native_claim(rig, caplog):
    driver, cli, lease = rig
    driver.adopt("7")
    lease.current = False
    before = list(cli.calls)
    native.unload_profile("work")
    assert native.get_driver("work", "s1") is driver
    assert driver.target is not None and driver.target.block == 7
    assert cli.calls == before
    assert "unload deferred unacknowledged cleanup (PermissionError)" in caplog.text
    assert not lease.closed  # keep the original quarantined lease; do not retarget it


def test_exact_late_open_cleanup_no_discovery_guess(rig):
    driver, cli, _ = rig
    cli.entries[73] = {"block": 73, "title": "Late", "url": "about:blank", "driven": True}
    driver.pending_open = True
    cli.late = {"block": 73}
    driver.reconcile_open()
    assert cli.calls == [{"op": "close", "block": 73}]
    assert driver.target is None and not driver.pending_open
    assert 7 in cli.entries


def test_unknown_open_quarantines_every_peer_in_window(rig):
    driver, cli, _ = rig
    driver.pending_open = True
    cli.late = {"error": "bad"}
    with pytest.raises(NativeBrowserError, match="open_unknown"):
        driver.reconcile_open()
    assert driver.unknown_open and driver.pending_open
    with pytest.raises(NativeBrowserError, match="open_unknown"):
        driver.open("https://example.net")
    assert not any(item.get("op") == "open" for item in cli.calls)
    assert 7 in cli.entries


def test_press_has_all_up_events_without_modifiers_leak():
    assert native.press_events("Ctrl+a") == [
        {"type": "key", "action": "down", "key": "Control", "mods": []},
        {"type": "key", "action": "down", "key": "a", "mods": ["ctrl"]},
        {"type": "key", "action": "up", "key": "a", "mods": ["ctrl"]},
        {"type": "key", "action": "up", "key": "Control", "mods": []},
    ]


def test_exact_tool_task_lookup_and_no_duplicate_claim(rig):
    driver, cli, lease = rig
    assert native.get_driver("work", "s1") is driver
    assert native.get_driver("work", "task-one") is None
    assert native.get_driver_for_tool("work", "tool-one", "task-one") is driver
    assert native.get_driver_for_tool("work", "tool-one", "unknown") is None
    assert native.has_native_driver("work") and not native.has_native_driver("other")
    with pytest.raises(NativeBrowserError, match="ownership"):
        native.get_driver_for_tool("work", "s1", "task-one")
    with pytest.raises(NativeBrowserError, match="ownership"):
        native.register_driver(native.BrowserScope(
            profile="work", rpc_session_id="s2", viewer_session_id="task-one",
            task_id="task-one", tool_session_id="tool-one",
            pane_vars=driver.scope.pane_vars, pane=3, window="w1",
            window_scope=driver.scope.window_scope, lease=FakeLease(), cli=FakeCLI(),
        ))
    assert native.get_driver("work", "s1") is driver
