#!/usr/bin/env python3
"""Owned POSIX PTY: drive raw terminal bytes into the real Bun/Tern SDK/App child."""
import errno
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
import tty
from pathlib import Path

# TSP v1 vocabulary from pinned @stencil-hq/tern wire.ts.
# Advertise and validate prefs and its nested native controls, not col/text/el only.
KINDS = [
    "col", "row", "card", "section", "rule", "spacer", "text", "md",
    "code", "diff", "ansi", "math", "image", "media", "kv", "table",
    "tree", "badge", "kbd", "icon", "spinner", "shimmer", "elapsed",
    "progress", "rate", "list", "item", "tabs", "editor", "input",
    "status", "seg", "overlay", "toast", "rows", "picker", "prefs",
    "tool", "checklist", "agent", "chart", "meter", "block", "effort", "el",
]
HELLO = {
    "r": "hello", "v": 1, "term": "tern", "ver": "0.4.3",
    "kinds": KINDS,
    "features": ["flow", "styles", "edit", "undo", "send"],
    "apc": 65536, "credits": 32, "cols": 100,
    "cell": {"w": 8, "h": 17}, "dark": True, "reduceMotion": False
}
QUERY = re.compile(rb"\x1b_tsp;q;(.*?)\x1b\\", re.DOTALL)
FRAME = re.compile(rb"\x1b_tsp;f;(.*?)\x1b\\", re.DOTALL)
UNICODE = "Café 文 😀"
PASTE = "!echo should-not-run {!touch /tmp/never}\n🧩 literal 😀"


def run(app_path: str, mode: str) -> dict:
    if mode not in ("plain", "vim"):
        raise ValueError("Unknown PTY test mode")
    # A timeout/termination from the test runner must still reap the owned child.
    def interrupted(signum, _frame):
        raise InterruptedError("PTY runner terminated by signal " + str(signum))

    signal.signal(signal.SIGTERM, interrupted)
    with tempfile.TemporaryDirectory(prefix="hermes-tern-real-pty-") as home:
        report = Path(home) / "gateway.json"
        master, slave = pty.openpty()
        tty.setraw(slave)
        os.set_blocking(master, False)
        env = os.environ.copy()
        for name in (
            "TMUX", "TMUX_PANE", "STY", "ZELLIJ", "TERN_TSP", "TERN_TSP_RECORD",
            "TERN_WINDOW_KEY", "HERMES_TUI_QUERY", "HERMES_TUI_RESUME",
            "HERMES_TERN_RESTORED", "HERMES_TUI_IMAGE", "HERMES_TERN_EVENT_LOG"
        ):
            env.pop(name, None)
        env["HERMES_HOME"] = home
        env["TERM"] = "xterm-256color"
        proc = None
        output = bytearray()
        scanned = 0
        frames = 0
        native_prefs = 0
        frame_parts = {}

        def read_status() -> dict:
            try:
                result = json.loads(report.read_text(encoding="utf-8"))
                return result if isinstance(result, dict) else {}
            except (FileNotFoundError, json.JSONDecodeError):
                return {}

        def validate_node(node) -> None:
            nonlocal native_prefs
            if not isinstance(node, dict) or node.get("k") not in KINDS:
                raise AssertionError("Unsupported or malformed TSP node " + repr(node)[:160])
            if node["k"] == "prefs":
                native_prefs += 1
            for child in node.get("c", []):
                validate_node(child)

        def pump(timeout: float = 0.012) -> None:
            nonlocal scanned, frames
            readable, _, _ = select.select([master], [], [], timeout)
            while readable:
                try:
                    part = os.read(master, 65536)
                except BlockingIOError:
                    break
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not part:
                    break
                output.extend(part)
                while True:
                    found = FRAME.search(output, scanned)
                    if not found:
                        break
                    scanned = found.end()
                    # Reassemble TSP c=..;m=1; frame chunks before validation.
                    raw = found.group(1)
                    params = {}
                    while True:
                        segment, sep, tail = raw.partition(b";")
                        if not sep or b"=" not in segment:
                            break
                        name, value = segment.split(b"=", 1)
                        if not re.fullmatch(rb"[a-zA-Z0-9_-]+", name):
                            break
                        params[name.decode("ascii")] = value.decode("ascii")
                        raw = tail
                    if "c" in params:
                        identifier = params["c"]
                        frame_parts.setdefault(identifier, bytearray()).extend(raw)
                        if params.get("m") == "1":
                            continue
                        raw = bytes(frame_parts.pop(identifier))
                    frame = json.loads(raw)
                    if not isinstance(frame, dict) or not isinstance(frame.get("sf"), str) \
                            or not isinstance(frame.get("s"), int) or not isinstance(frame.get("ops"), list):
                        raise AssertionError("Malformed TSP frame from SDK: " + repr(frame)[:200])
                    for op in frame["ops"]:
                        if not isinstance(op, list) or not op or not isinstance(op[0], str):
                            raise AssertionError("Malformed TSP operation " + repr(op))
                        if op[0] == "add":
                            if len(op) != 5:
                                raise AssertionError("Malformed TSP add op " + repr(op))
                            validate_node(op[4])
                    frames += 1
                    ack = {"ev": "ack", "sf": frame["sf"], "s": frame["s"]}
                    os.write(master, b"\x1b_tsp;e;" + json.dumps(ack).encode("utf-8") + b"\x1b\\")
                readable, _, _ = select.select([master], [], [], 0)

        def wait(label: str, predicate, seconds: float = 7.0) -> None:
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                pump()
                if predicate():
                    return
                if proc is not None and proc.poll() is not None:
                    # Expected exit can land between the predicate and poll.
                    if predicate():
                        return
                    raise AssertionError(
                        label + ": child exited " + str(proc.returncode) + "\n"
                        + output[-4000:].decode("utf-8", "replace")
                    )
            raise AssertionError(
                label + ": deadline expired; status=" + repr(read_status())
                + "\n" + output[-4000:].decode("utf-8", "replace")
            )

        def send(parts) -> None:
            for part in parts:
                view = memoryview(part)
                while view:
                    count = os.write(master, view)
                    view = view[count:]
                pump(0.006)

        def tsp(event: dict) -> bytes:
            return b"\x1b_tsp;e;" + json.dumps(event, ensure_ascii=False).encode("utf-8") + b"\x1b\\"

        def calls(method: str) -> list:
            return [
                item for item in read_status().get("calls", [])
                if isinstance(item, dict) and item.get("method") == method
            ]

        try:
            proc = subprocess.Popen(
                ["bun", app_path, str(report), mode],
                stdin=slave, stdout=slave, stderr=slave,
                cwd=os.getcwd(), env=env, start_new_session=True, close_fds=True
            )
            os.close(slave)
            slave = -1

            wait("real SDK hello/DA1", lambda: QUERY.search(output) is not None and b"\x1b[c" in output)
            query = json.loads(QUERY.search(output).group(1))
            if query.get("q") != "hello" or query.get("app") != "hermes":
                raise AssertionError("Unexpected real SDK hello: " + repr(query))
            if query.get("features") != ["edit", "undo", "send"]:
                raise AssertionError("SDK did not request composer capabilities")
            send([b"\x1b_tsp;r;" + json.dumps(HELLO).encode("utf-8") + b"\x1b\\", b"\x1b[?62;52;c"])
            wait("TSP App surface and rendering", lambda: b"\x1b_tsp;o;" in output and frames > 0)
            wait("gateway adoption/profile", lambda:
                 read_status().get("ready") is True
                 and read_status().get("vim") is (mode == "vim"))
            insert_seen = False
            if mode == "vim":
                send([b"\x1b"])
                wait("Vim Normal from raw Escape", lambda: read_status().get("vimMode") == "normal")
                send([b"i"])
                wait("Vim Insert from raw i", lambda: read_status().get("vimMode") == "insert")
                insert_seen = True

            # Root A: real raw /settings, the canonical owner, and a native prefs frame.
            send([b"/settings"])
            wait("raw settings draft", lambda: read_status().get("draft") == "/settings")
            send([b"\r"])
            wait("native Settings A open and canonical owner read", lambda:
                 "settings" in read_status().get("overlays", [])
                 and str(read_status().get("settingsRoot", "")).startswith("settings-")
                 and read_status().get("canonicalProfile") == "default"
                 and any(c.get("params", {}).get("key") == "skin" for c in calls("config.get"))
                 and native_prefs > 0)
            root_a = "layer." + read_status()["settingsRoot"]
            send([b"\x1b"])
            wait("Settings A closed through raw Escape", lambda:
                 "settings" not in read_status().get("overlays", []))

            # Render B, then deliver old A IDs through actual SDK event routing.
            send([b"/settings"])
            wait("raw second settings command", lambda: read_status().get("draft") == "/settings")
            send([b"\r"])
            wait("native Settings B has distinct root and new prefs frame", lambda:
                 "settings" in read_status().get("overlays", [])
                 and str(read_status().get("settingsRoot", "")).startswith("settings-")
                 and ("layer." + str(read_status()["settingsRoot"])) != root_a
                 and len([c for c in calls("config.get") if c.get("params", {}).get("key") == "skin"]) >= 2
                 and native_prefs >= 2)
            root_b = "layer." + read_status()["settingsRoot"]
            send([
                tsp({"ev": "change", "sf": "hermes", "id": root_a, "item": "busy", "value": "interrupt"}),
                tsp({"ev": "action", "sf": "hermes", "id": root_a, "act": "page", "value": "profile.Safety"}),
                tsp({"ev": "action", "sf": "hermes", "id": root_b, "act": "page", "value": "profile.Agent"})
            ])
            wait("B page action dispatched through actual SDK", lambda:
                 read_status().get("settingsPage") == "profile.Agent")
            if calls("config.set") or read_status().get("settingsBusy") != "queue":
                raise AssertionError("Stale A native event mutated B")
            send([tsp({"ev": "change", "sf": "hermes", "id": root_b, "item": "busy", "value": "steer"})])
            wait("B native prefs change performs scoped write/readback", lambda:
                 len(calls("config.set")) == 1
                 and read_status().get("settingsBusy") == "steer"
                 and len([c for c in calls("config.get") if c.get("params", {}).get("key") == "busy"]) >= 4)
            send([b"\x1b"])
            wait("Settings B closes", lambda: "settings" not in read_status().get("overlays", []))

            # The actual slash command is typed in a terminal; no direct App edits or sends.
            send([b"/ask status"])
            wait("raw slash composer draft", lambda: read_status().get("draft") == "/ask status")
            send([b"\r"])
            wait("slash dispatch via Enter", lambda: len(calls("slash.exec")) == 1)

            raw = UNICODE.encode("utf-8")
            e = raw.index("é".encode("utf-8")) + 1
            emoji = raw.index("😀".encode("utf-8")) + 2
            send([raw[:e], raw[e:emoji], raw[emoji:]])
            wait("split UTF-8 composer draft", lambda: read_status().get("draft") == UNICODE)
            before = read_status()
            # Invoke the real opening command while RAW keyboard draft is held.
            # Neither input.edit nor input.send is fabricated in this scenario.
            Path(str(report) + ".control").write_text("open-settings", encoding="utf-8")
            wait("Settings C opens without stealing raw composer", lambda:
                 "settings" in read_status().get("overlays", [])
                 and str(read_status().get("settingsRoot", "")).startswith("settings-")
                 and ("layer." + str(read_status()["settingsRoot"])) not in (root_a, root_b))
            root_c = "layer." + read_status()["settingsRoot"]
            send([tsp({"ev": "change", "sf": "hermes", "id": root_c, "item": "theme", "value": "dark"})])
            wait("native owner-scoped save while raw draft held", lambda:
                 len(calls("config.set")) == 2 and read_status().get("settingsTheme") == "dark")
            send([b"\x1b"])
            wait("Settings C close keeps text/caret/paste provenance", lambda:
                 "settings" not in read_status().get("overlays", [])
                 and read_status().get("draft") == before["draft"]
                 and read_status().get("caret") == before["caret"]
                 and read_status().get("pasted") == before["pasted"])
            send([b"\r"])
            wait("split UTF-8 prompt via Enter", lambda:
                 len(calls("prompt.submit")) == 1 and read_status().get("idle") is True)

            # Split both bracketed-paste delimiters and a 4-byte emoji; Vim must not
            # reinterpret its contents as Normal commands or shell instructions.
            data = PASTE.encode("utf-8")
            cut = data.index("🧩".encode("utf-8")) + 2
            send([b"\x1b[20", b"0~", data[:cut], data[cut:], b"\x1b[20", b"1~"])
            wait("paste remains literal with command provenance", lambda:
                 read_status().get("draft") == PASTE and read_status().get("pasted") == [PASTE])
            # Real Ctrl+Z traverses the Tern raw-key parser; paste undo restores
            # both the original empty draft and the command-safety provenance.
            send([b"\x1a"])
            wait("raw undo restores empty draft and removes paste provenance", lambda:
                 read_status().get("draft") == "" and read_status().get("pasted") == [])
            send([b"\x1b[20", b"0~", data[:cut], data[cut:], b"\x1b[20", b"1~"])
            wait("raw paste after undo retains inert provenance", lambda:
                 read_status().get("draft") == PASTE and read_status().get("pasted") == [PASTE])
            send([b"\r"])
            wait("literal bracketed paste via Enter", lambda:
                 len(calls("prompt.submit")) == 2 and read_status().get("idle") is True)
            send([b"\x04"])  # Ctrl+D with an empty draft goes through App's quit key rule.
            wait("clean App/SDK exit", lambda: proc.poll() is not None, seconds=7.0)
            if proc.returncode != 0:
                raise AssertionError(
                    "App/SDK exited " + str(proc.returncode) + "\n"
                    + output[-4000:].decode("utf-8", "replace")
                )
            result = read_status()
            if result.get("closed") is not True:
                raise AssertionError("App failed to close through its own key path")
            return {
                "handshake": True,
                "opened": b"\x1b_tsp;o;" in output,
                "bracketed": b"\x1b[?2004h" in output,
                "frames": frames,
                "nativePrefsFrames": native_prefs,
                "rootA": root_a,
                "rootB": root_b,
                "rootC": root_c,
                "staleRejected": True,
                "undoProved": True,
                "composerPreserved": True,
                "closed": result["closed"],
                "vim": result["vim"],
                "vimInsert": insert_seen,
                "literalProvenance": True,
                "settingsOpened": True,
                "calls": result["calls"]
            }
        finally:
            if proc is not None and proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait(timeout=1)
            if slave >= 0:
                os.close(slave)
            os.close(master)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: pty-host.py <pty-app.ts> <plain|vim>")
    print(json.dumps(run(sys.argv[1], sys.argv[2]), ensure_ascii=False))
