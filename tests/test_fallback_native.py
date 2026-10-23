"""Opt-in, *real-process* exit-75 qualification, not a Tern-window simulation.

Run only after building frontend/dist/entry.js and the pinned Hermes Ink bundle,
with an isolated /tmp Hermes source and installed Python dependencies. The real
plugin _run -> _chat -> hermes_cli.main -> _launch_tui -> Node path is used.
The HERMES_NODE wrapper logs argv/scoped environment and *execs* the real Node;
it does not replace a subprocess, the Tern handshake, an exit code, or Ink.
No provider calls, credentials, ambient panes or installed Hermes CLI wrapper.
"""

from __future__ import annotations

import errno
import os
import pty
import select
import shlex
import shutil
import signal
import subprocess
import sys
import time
import tty
from pathlib import Path

import pytest

pytestmark = pytest.mark.native_fallback

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
ENTRY = FRONTEND / "dist" / "entry.js"
PIN = "22063fc099ec9ad8357d7f8f6e6248a0400680d3"
BANNER = b"starting the regular TUI"
# APC carries TSP messages. Ink should never emit another TSP frame after fallback.
TSP_FRAME = b"\x1b_"

# The test driver imports the plugin as an ordinary package, then exercises its
# real command handler. No replacement Hermes core entrypoint or process mocks.
DRIVER = """
import argparse
import importlib.util
import os
from pathlib import Path
import sys

source, root = map(Path, sys.argv[1:3])
sys.path.insert(0, str(source))
spec = importlib.util.spec_from_file_location(
    'hermes_tern_fallback_native', root / '__init__.py',
    submodule_search_locations=[str(root)])
assert spec is not None and spec.loader is not None
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
plugin._run(argparse.Namespace(tui_args=[], worktree=False))
"""


@pytest.fixture(scope="module")
def native_source() -> tuple[Path, str]:
    assert os.name == "posix", "PTY native fallback qualification requires POSIX"
    node = shutil.which("node")
    assert node is not None, "Install Node 22 before native fallback qualification"
    source_env = os.environ.get("HERMES_FALLBACK_SOURCE")
    assert source_env, "Set HERMES_FALLBACK_SOURCE to an isolated /tmp checkout of the pinned Hermes commit"
    source = Path(source_env).resolve(strict=True)
    assert source.is_relative_to(Path("/tmp").resolve()), "Never launch the installed or live Hermes source"
    head = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True, timeout=10,
    ).stdout.strip()
    assert head == PIN, f"Hermes source must be pinned to {PIN}, got {head}"
    assert (FRONTEND / "hermes-src.lock").read_text().strip() == PIN
    assert ENTRY.is_file() and ENTRY.stat().st_size > 100_000, "Missing compiled Tern bundle"
    assert ENTRY.stat().st_mtime_ns > (FRONTEND / "src" / "entry.ts").stat().st_mtime_ns, (
        "Build the current frontend first: cd frontend && bun run bundle"
    )
    ink = source / "hermes_cli" / "tui_dist" / "entry.js"
    assert ink.is_file() and ink.stat().st_size > 100_000, (
        "Build the actual pinned ui-tui/dist/entry.js, then copy it to the "
        "isolated source's hermes_cli/tui_dist/entry.js; no lazy install"
    )
    return source, str(Path(node).resolve())


def _environment(tmp_path: Path, source: Path, node: str) -> dict[str, str]:
    """Copy runtime necessities, not provider keys, tokens, or user settings."""
    env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "TZ") if k in os.environ}
    home = tmp_path / "home" / "profiles" / "native"
    home.mkdir(parents=True)
    env.update({
        "HOME": str(tmp_path / "home"),
        "HERMES_HOME": str(home),
        "XDG_CONFIG_HOME": str(tmp_path / "config"),
        "XDG_CACHE_HOME": str(tmp_path / "cache"),
        "XDG_DATA_HOME": str(tmp_path / "data"),
        "PYTHONPATH": str(source),
        "HERMES_DISABLE_LAZY_INSTALLS": "1",
        "HERMES_DISABLE_FAST_CHAT_LAUNCH": "1",
        "HERMES_NODE": node,
        "TERM": "xterm-256color",
        "TERM_PROGRAM": "xterm",
        "HERMES_TERN": "1",
    })
    return env


def _pty_process(argv: list[str], *, cwd: Path, env: dict[str, str],
                 timeout: float = 45, close_ink: bool = False) -> tuple[int, bytes]:
    """Real slave PTY with bounded stdout and cleanup; not a fake terminal parser."""
    master, slave = pty.openpty()
    tty.setraw(slave)
    child = None
    output = bytearray()
    start = time.monotonic()
    last_read = start
    sent_quit = False
    sent_interrupt = False
    try:
        child = subprocess.Popen(
            argv, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        slave = -1
        while time.monotonic() - start < timeout:
            readable, _, _ = select.select([master], [], [], 0.15)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    chunk = b""
                if chunk:
                    output.extend(chunk)
                    assert len(output) <= 2_000_000, "Unbounded output from native PTY"
                    last_read = time.monotonic()
            if child.poll() is not None and time.monotonic() - last_read > 0.3:
                break
            if close_ink and BANNER in output:
                # Ctrl+D is the ordinary Ink quit request. If it is unavailable
                # at a first-run screen, deliver terminal Ctrl+C twice.
                age = time.monotonic() - start
                if not sent_quit and age > 8:
                    os.write(master, b"\x04")
                    sent_quit = True
                elif not sent_interrupt and age > 15:
                    os.write(master, b"\x03\x03")
                    sent_interrupt = True
        assert child.poll() is not None, (
            f"PTY child hung (elapsed {time.monotonic() - start:.1f}s); "
            f"last bytes: {bytes(output)[-1200:]!r}"
        )
        return child.wait(timeout=2), bytes(output)
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
        os.close(master)
        if slave >= 0:
            os.close(slave)


def _node_shim(tmp_path: Path, node: str) -> Path:
    """Trace ONLY entry launches; exec the exact real Node with unmodified argv."""
    script = tmp_path / "node-record"
    script.write_text(
        "#!/bin/sh\n"
        'case " $* " in\n'
        '  *entry.js*)\n'
        '    printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" \\\n'
        '      "$HERMES_TUI_DIR" "$*" "$HERMES_HOME" "$TERM_PROGRAM" \\\n'
        '      "$TERN_PANE" "$HERMES_TERN_LAUNCH_CWD" \\\n'
        '      "$HERMES_TERN_RESTORED" "$HERMES_TUI_RESUME" >> "$HERMES_FALLBACK_CALLS"\n'
        '    ;;\n'
        'esac\n'
        f"exec {shlex.quote(node)} \"$@\"\n"
    )
    script.chmod(0o700)
    return script


def _calls(path: Path) -> list[dict[str, str]]:
    labels = ("frontend_dir", "argv", "home", "terminal", "pane", "cwd", "restored", "resume")
    assert path.exists(), "Hermes never started a real compiled TUI entry"
    records = []
    for line in path.read_text().splitlines():
        parts = line.split("\t")
        assert len(parts) == len(labels), f"Bad actual Node launch receipt: {line!r}"
        records.append(dict(zip(labels, parts)))
    return records


def _hermes_driver(source: Path) -> list[str]:
    return [sys.executable, "-I", "-c", DRIVER, str(source), str(ROOT)]


def _assert_two_real_entries(calls: list[dict[str, str]],
                             source: Path, env: dict[str, str]) -> None:
    ink = source / "hermes_cli" / "tui_dist" / "entry.js"
    assert len(calls) == 2, f"Expected real TSP attempt and exactly one real Ink retry: {calls}"
    assert str(ENTRY) in calls[0]["argv"], calls
    assert str(ink) in calls[1]["argv"], calls
    assert calls[0]["frontend_dir"] == str(FRONTEND), calls
    assert calls[1]["frontend_dir"] == "", calls
    for call in calls:
        assert call["home"] == env["HERMES_HOME"], calls
        assert call["terminal"] == env["TERM_PROGRAM"], calls
        assert call["pane"] == env.get("TERN_PANE", ""), calls
        assert call["cwd"] == str(ROOT), calls


def test_actual_compiled_entry_exits_75_without_tty(native_source, tmp_path):
    source, node = native_source
    env = _environment(tmp_path, source, node)
    result = subprocess.run(
        [node, "--expose-gc", str(ENTRY)], cwd=FRONTEND, env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=20, check=False,
    )
    assert result.returncode == 75, (result.returncode, result.stdout[-800:], result.stderr[-800:])


@pytest.mark.parametrize("markers", [
    {},
    {"SSH_CONNECTION": "fixture-only", "TERM_PROGRAM": "xterm"},
    {"TMUX": "/fixture/tmux,0,0", "TERM_PROGRAM": "tern"},
    {"STY": "fixture-screen", "TERM_PROGRAM": "tern"},
    {"ZELLIJ": "fixture-only", "TERM_PROGRAM": "tern"},
], ids=["ordinary-local-pty", "ssh-marker-only", "tmux-marker-only",
        "screen-marker-only", "zellij-marker-only"])
def test_actual_compiled_entry_fails_closed_in_non_tern_pty(native_source, tmp_path, markers):
    """Each child owns a real PTY; marker values are NOT an SSH/mux transport."""
    source, node = native_source
    env = _environment(tmp_path, source, node)
    env.update(markers)
    code, output = _pty_process([node, "--expose-gc", str(ENTRY)],
                                cwd=FRONTEND, env=env, timeout=20)
    assert code == 75, (markers, code, output[-1200:])


def test_actual_launcher_retries_ink_once_without_tty(native_source, tmp_path):
    source, node = native_source
    env = _environment(tmp_path, source, node)
    env["HERMES_FALLBACK_CALLS"] = str(tmp_path / "calls.tsv")
    env["HERMES_NODE"] = str(_node_shim(tmp_path, node))
    result = subprocess.run(
        _hermes_driver(source), cwd=ROOT, env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=65, check=False,
    )
    _assert_two_real_entries(_calls(tmp_path / "calls.tsv"), source, env)
    assert result.stderr.count(BANNER) == 1, (result.returncode, result.stderr[-1500:])
    assert result.returncode != 75, "Ink must own the final exit, not the no-TSP handshake"
    assert TSP_FRAME not in result.stderr.split(BANNER, 1)[1], "TSP after Ink takeover"


def test_actual_launcher_ink_paints_and_cleans_up_real_pty(native_source, tmp_path):
    source, node = native_source
    env = _environment(tmp_path, source, node)
    # Deliberately synthetic pane identity: proves scope forwarding, not Tern GUI.
    env["TERN_PANE"] = "7"
    env["HERMES_FALLBACK_CALLS"] = str(tmp_path / "calls.tsv")
    env["HERMES_NODE"] = str(_node_shim(tmp_path, node))
    code, output = _pty_process(_hermes_driver(source), cwd=ROOT, env=env,
                                timeout=65, close_ink=True)
    _assert_two_real_entries(_calls(tmp_path / "calls.tsv"), source, env)
    assert output.count(BANNER) == 1, (code, output[-2000:])
    after_ink = output.split(BANNER, 1)[1]
    assert b"\x1b[" in after_ink, "Real Ink did not paint a terminal frame"
    assert TSP_FRAME not in after_ink, "No TSP APC frame may escape after Ink takes over"
    assert code in (0, 130), (code, output[-2000:])


def test_explicit_ordinary_tui_uses_real_ink_without_a_tern_attempt(native_source, tmp_path):
    source, node = native_source
    env = _environment(tmp_path, source, node)
    env["HERMES_TERN"] = "0"
    env["HERMES_FALLBACK_CALLS"] = str(tmp_path / "calls.tsv")
    env["HERMES_NODE"] = str(_node_shim(tmp_path, node))
    result = subprocess.run(
        _hermes_driver(source), cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=65, check=False,
    )
    calls = _calls(tmp_path / "calls.tsv")
    ink = source / "hermes_cli" / "tui_dist" / "entry.js"
    assert len(calls) == 1 and str(ink) in calls[0]["argv"], calls
    assert calls[0]["frontend_dir"] == "", calls
    assert calls[0]["home"] == env["HERMES_HOME"]
    assert BANNER not in result.stderr, result.stderr[-1500:]
    assert result.returncode != 75, result.stderr[-1500:]
