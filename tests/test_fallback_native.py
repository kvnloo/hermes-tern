"""Opt-in real-process exit-75 qualification, not a Tern-window simulation.

The real plugin _run -> _chat -> pinned Hermes _launch_tui -> Node path runs
against independently built Tern and Ink entries. The Node recorder only writes
lossless JSON argv/environment receipts, then execs the actual Node interpreter.
Every subprocess owns a new process group; both PTY and pipe captures are bounded
and clean up the whole owned group, even if the Python driver has already exited.
Detached gateway cleanup is Linux-only: Python 3.11+, pidfd_open,
pidfd_send_signal, select.poll and accessible /proc start-time and cmdline
identity are mandatory. It fails closed without a process handle, never
falling back to a raw numeric PID signal.

No provider requests, ambient profiles/credentials/panes, mock entrypoint, or
fabricated exit-75 response. SSH/mux environment probes are markers, NOT real
transport tests. Run this module explicitly with -m native_fallback.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import pty
import select
import selectors
import shutil
import signal
import subprocess
import sys
import time
import tty
import uuid
from pathlib import Path

import pytest

pytestmark = pytest.mark.native_fallback

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
ENTRY = FRONTEND / "dist" / "entry.js"
PIN = "22063fc099ec9ad8357d7f8f6e6248a0400680d3"
BANNER = b"starting the regular TUI"
TSP_FRAME = b"\x1b_"  # TSP is carried in APC; Ink must never emit another frame.
INK_HELP_MARKER = b"/quit"  # The real pinned Ink HelpHint, opened with '?'.
OUTPUT_LIMIT = 2_000_000

# -I ignores inherited PYTHONPATH; the isolated source is inserted explicitly.
# A resume fixture is created using the REAL pinned SessionDB API before launch,
# rather than pretending a TERN_PANE exists or inventing a missing session.
DRIVER = """
import argparse
import importlib.util
import os
from pathlib import Path
import sys

source, root = map(Path, sys.argv[1:3])
sys.path.insert(0, str(source))
resume_id = os.environ.get('HERMES_FALLBACK_RESUME_ID', '')
if resume_id:
    from hermes_state import SessionDB
    saved_cwd = Path(os.environ['HERMES_FALLBACK_RESUME_CWD']).resolve(strict=True)
    db = SessionDB(db_path=Path(os.environ['HERMES_HOME']) / 'state.db')
    try:
        db.create_session(resume_id, source='tui', cwd=str(saved_cwd), profile_name='default')
        row = db.get_session(resume_id)
        assert row is not None and row['cwd'] == str(saved_cwd)
        assert row['profile_name'] == 'default'
    finally:
        db.close()

spec = importlib.util.spec_from_file_location(
    'hermes_tern_fallback_native', root / '__init__.py',
    submodule_search_locations=[str(root)])
assert spec is not None and spec.loader is not None
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
args = ['--', '--pass-session-id']  # Pinned Hermes CLI supports this safe no-request flag.
if resume_id:
    args.extend(['--resume', resume_id])
plugin._run(argparse.Namespace(tui_args=args, worktree=False))
"""


def _group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    return True


def _cleanup_owned_group(child: subprocess.Popen) -> None:
    """Reap driver and terminate ONLY its fresh session, including orphaned Node.

    The driver invokes pinned Hermes subprocess.call(Node). Waiting/killing only
    the driver is insufficient: Node (or its gateway) can retain our PTY/pipes
    after that parent exits. The child PID is the owned new-session PGID.
    """
    pgid = child.pid
    if _group_exists(pgid):
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        until = time.monotonic() + 0.75
        while time.monotonic() < until and _group_exists(pgid):
            time.sleep(0.05)
        if _group_exists(pgid):
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        # The same owned process, not a global pkill or unrelated PID.
        if _group_exists(pgid):
            os.killpg(pgid, signal.SIGKILL)
        child.kill()
        child.wait(timeout=3)


def _bounded_capture(
    argv: list[str], *, cwd: Path, env: dict[str, str], timeout: float = 20,
) -> tuple[int, bytes, bytes]:
    """Drain BOTH non-TTY streams incrementally; overflow fails, never truncates.

    Capturing via subprocess.run(timeout=...) would kill only the Python parent
    and could leave Hermes' subprocess.call(Node) holding the pipe writers.
    This helper owns a new session, enforces a combined byte budget, and reaps
    the entire group on every success and failure path.
    """
    assert os.name == "posix"
    child = subprocess.Popen(
        argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
    )
    stdout, stderr = bytearray(), bytearray()
    deadline = time.monotonic() + timeout
    exited_at = None
    try:
        assert child.stdout is not None and child.stderr is not None
        with selectors.DefaultSelector() as readers:
            readers.register(child.stdout, selectors.EVENT_READ, stdout)
            readers.register(child.stderr, selectors.EVENT_READ, stderr)
            while readers.get_map() or child.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        f"Owned non-TTY group {child.pid} exceeded {timeout}s; "
                        f"stdout={bytes(stdout)[-800:]!r} stderr={bytes(stderr)[-800:]!r}"
                    )
                if child.poll() is not None and readers.get_map():
                    if exited_at is None:
                        exited_at = time.monotonic()
                    elif time.monotonic() - exited_at > 2:
                        raise AssertionError(
                            "Python driver exited but a descendant held its non-TTY pipes open"
                        )
                for key, _ in readers.select(min(0.15, remaining)):
                    # Read one past the remaining budget to positively detect overflow.
                    remaining_bytes = OUTPUT_LIMIT - len(stdout) - len(stderr)
                    chunk = os.read(key.fileobj.fileno(), min(65536, remaining_bytes + 1))
                    if not chunk:
                        readers.unregister(key.fileobj)
                        continue
                    if len(chunk) > remaining_bytes:
                        raise AssertionError(
                            f"Native non-TTY output exceeded {OUTPUT_LIMIT} bytes"
                        )
                    key.data.extend(chunk)
                if not readers.get_map() and child.poll() is None:
                    # No writers remain: bounded wait still required for process exit.
                    try:
                        child.wait(timeout=min(0.15, max(0.01, deadline - time.monotonic())))
                    except subprocess.TimeoutExpired:
                        pass
        return child.wait(timeout=1), bytes(stdout), bytes(stderr)
    finally:
        _cleanup_owned_group(child)
        if child.stdout is not None:
            child.stdout.close()
        if child.stderr is not None:
            child.stderr.close()



# Pinned Hermes starts its shared local gateway with start_new_session=True
# (gateway_runtime_start.spawn_unmanaged_gateway). It is not a child in our
# PTY/pipe driver's PGID. Dispose of it separately, but ONLY after the real
# Hermes status/identity guard proves that this temporary profile owns it.
# Do not use gateway stop --all, pkill or ambient PID guesses.
STOP_ISOLATED_GATEWAY = """
import json
import os
import select
import signal
import sys
from pathlib import Path


def _shutdown_owned_gateway(home, verify_owner, write_planned_stop,
                            matches_live_gateway, read_cmdline, marker_filename):
    # Pinned gateway.status.terminate_pid checks expected_start_time only
    # when FORCE is set. Numeric-PID os.kill(SIGTERM) is unsafe.
    if (sys.platform != 'linux' or sys.version_info < (3, 11)
            or not callable(getattr(os, 'pidfd_open', None))
            or not callable(getattr(signal, 'pidfd_send_signal', None))
            or not callable(getattr(select, 'poll', None))):
        raise RuntimeError(
            'Native fallback prerequisite: Linux Python 3.11+, '
            'os.pidfd_open, signal.pidfd_send_signal, pollable pidfds; '
            'never fall back to os.kill on a detached PID'
        )
    record_file = home / 'gateway.pid'
    if record_file.is_symlink():
        raise RuntimeError('Refusing a symlinked isolated gateway PID record')
    if not record_file.exists():
        return  # No detached gateway in this isolated HERMES_HOME.
    original = record_file.read_bytes()
    record = json.loads(original)
    if not isinstance(record, dict):
        raise RuntimeError('Isolated gateway PID record is not an object')
    pid = record.get('pid')
    if type(pid) is not int or pid <= 1:
        raise RuntimeError('Isolated gateway record lacks a valid PID')

    # Kernel process handle acquired BEFORE the final identity checks.
    try:
        handle = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        return  # Original is dead; signal nobody.
    try:
        verdict = verify_owner(home, record)
        if isinstance(verdict, str):
            raise RuntimeError('Refusing an unverified or foreign owner: ' + verdict)
        verified_pid, started_at = verdict
        # Pinned matcher allows a two-second tolerance on other platforms;
        # supported Linux /proc start ticks MUST match exactly.
        if (type(verified_pid) is not int or verified_pid != pid
                or type(record.get('start_time')) is not int
                or type(started_at) is not int
                or record['start_time'] != started_at):
            raise RuntimeError('Refusing recycled or unverifiable gateway start-time')
        if (not read_cmdline(pid)
                or not matches_live_gateway(record, pid, expected_home=home)):
            raise RuntimeError('Refusing gateway without live process/profile proof')
        if record_file.read_bytes() != original:
            raise RuntimeError('Isolated gateway PID record changed during verification')

        poller = select.poll()
        poller.register(handle, select.POLLIN | select.POLLHUP |
                        select.POLLERR | select.POLLNVAL)

        def exited(wait_ms):
            for event_fd, event_flags in poller.poll(wait_ms):
                if event_fd != handle or event_flags & (select.POLLERR | select.POLLNVAL):
                    raise RuntimeError('Invalid isolated gateway pidfd readiness')
                if event_flags & (select.POLLIN | select.POLLHUP):
                    return True
            return False

        if exited(0):
            return
        write_planned_stop(home, pid, started_at)
        marker = json.loads((home / marker_filename).read_text(encoding='utf-8'))
        if (not isinstance(marker, dict)
                or marker.get('target_pid') != pid
                or marker.get('target_start_time') != started_at
                or marker.get('stopper_pid') != os.getpid()):
            raise RuntimeError('Isolated planned-stop marker was not verified')
        if exited(0):
            return
        try:
            signal.pidfd_send_signal(handle, signal.SIGTERM, None, 0)
        except ProcessLookupError:
            if exited(0):
                return
            raise RuntimeError('SIGTERM reported missing owner without pidfd exit proof')
        if exited(2000):
            return
        try:
            signal.pidfd_send_signal(handle, signal.SIGKILL, None, 0)
        except ProcessLookupError:
            if exited(0):
                return
            raise RuntimeError('SIGKILL reported missing owner without pidfd exit proof')
        if not exited(2000):
            raise RuntimeError('Verified isolated gateway pidfd did not exit')
    finally:
        os.close(handle)


if __name__ == '__main__':
    source, home = map(Path, sys.argv[1:3])
    sys.path.insert(0, str(source))
    from hermes_cli.gateway_runtime_replace import _verified_owner, _write_planned_stop
    from gateway.status import (
        _record_matches_live_gateway_pid, _read_process_cmdline,
        _PLANNED_STOP_MARKER_FILENAME,
    )
    _shutdown_owned_gateway(
        home.resolve(strict=True), _verified_owner, _write_planned_stop,
        _record_matches_live_gateway_pid, _read_process_cmdline,
        _PLANNED_STOP_MARKER_FILENAME,
    )
"""


def _stop_isolated_gateway(source: Path, env: dict[str, str]) -> None:
    home = Path(env["HERMES_HOME"]).resolve(strict=True)
    # Distinct, disposable $HOME; never target any installed profile/service.
    assert home == Path(env["HOME"]).resolve(strict=True) / ".hermes"
    code, stdout, stderr = _bounded_capture(
        [sys.executable, "-I", "-c", STOP_ISOLATED_GATEWAY, str(source), str(home)],
        cwd=source, env=env, timeout=12,
    )
    assert code == 0, (
        "The pinned gateway shutdown/owner check failed; inspect this isolated "
        "profile and do not call native fallback accepted",
        code, stdout[-1500:], stderr[-1500:],
    )


def _capture_driver(source: Path, env: dict[str, str]) -> tuple[int, bytes, bytes]:
    try:
        return _bounded_capture(_hermes_driver(source), cwd=ROOT, env=env, timeout=65)
    finally:
        _stop_isolated_gateway(source, env)


def _pty_driver(source: Path, env: dict[str, str]) -> tuple[int, bytes]:
    try:
        return _pty_process(_hermes_driver(source), cwd=ROOT, env=env,
                            timeout=65, close_ink=True)
    finally:
        _stop_isolated_gateway(source, env)


def _git_read(cwd: Path, *args: str) -> str:
    code, stdout, stderr = _bounded_capture(
        ["git", "-C", str(cwd), *args], cwd=cwd, env=dict(os.environ),
        timeout=12,
    )
    assert code == 0, (args, code, stdout[-800:], stderr[-800:])
    return stdout.decode("utf-8").strip()


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(128 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


@pytest.fixture(scope="module")
def native_source() -> tuple[Path, str]:
    assert os.name == "posix", "Real PTY fallback requires POSIX"
    node = shutil.which("node")
    assert node is not None, "Node 22 is a real native prerequisite"
    source_env = os.environ.get("HERMES_FALLBACK_SOURCE")
    assert source_env, "Set HERMES_FALLBACK_SOURCE to the isolated /tmp pinned checkout"
    source = Path(source_env).resolve(strict=True)
    assert source.is_relative_to(Path("/tmp").resolve()), (
        "Native tests must not touch an installed/live Hermes checkout"
    )
    assert _git_read(source, "rev-parse", "HEAD") == PIN
    assert (FRONTEND / "hermes-src.lock").read_text().strip() == PIN

    # HEAD/mtime alone do NOT establish source provenance. Reject modifications
    # to pinned tracked source/build inputs; generated outputs are untracked.
    assert not _git_read(source, "status", "--porcelain=v1", "--untracked-files=no",
                         "--", "hermes_cli", "ui-tui", "scripts"), (
        "The pinned Hermes tracked build inputs were modified"
    )
    assert not _git_read(ROOT, "status", "--porcelain=v1", "--untracked-files=no",
                         "--", "__init__.py", "frontend/src", "frontend/hermes-src.lock"), (
        "The plugin tracked launch/source inputs differ from this checkout"
    )

    assert ENTRY.is_file() and ENTRY.stat().st_size > 100_000, (
        "Build the real frontend/dist/entry.js with bun run bundle"
    )
    built_ink = source / "ui-tui" / "dist" / "entry.js"
    installed_ink = source / "hermes_cli" / "tui_dist" / "entry.js"
    assert built_ink.is_file() and installed_ink.is_file(), (
        "Build the pinned ui-tui and copy its actual dist/entry.js to "
        "hermes_cli/tui_dist/entry.js in the isolated checkout"
    )
    assert built_ink.stat().st_size > 100_000 and installed_ink.stat().st_size > 100_000
    assert _digest(built_ink) == _digest(installed_ink), (
        "The pinned Ink bundle and its copied runtime entry differ"
    )
    # Content receipts establish identity of the observed binaries, NOT proof
    # that a build was performed in this test process. OMP must record the
    # source pin, fresh build commands and these SHA-256 digests separately.
    print(f"native fallback artifact SHA-256 Tern={_digest(ENTRY)} Ink={_digest(installed_ink)}")
    return source, str(Path(node).resolve())


def _environment(tmp_path: Path, source: Path, node: str) -> dict[str, str]:
    """Only runtime basics, never inherited user config or provider credentials."""
    env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "TZ") if k in os.environ}
    home = tmp_path / "home"
    profile = home / ".hermes"
    profile.mkdir(parents=True)
    env.update({
        "HOME": str(home),
        "HERMES_HOME": str(profile),
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
    # No synthetic TERN_PANE; a real Tern pane/GUI needs its own beta-account
    # acceptance run, not an invented identity in this local PTY test.
    assert "TERN_PANE" not in env
    return env


def _pty_process(
    argv: list[str], *, cwd: Path, env: dict[str, str],
    timeout: float = 45, close_ink: bool = False,
) -> tuple[int, bytes]:
    """Real raw slave PTY; one owned session and finite capture/cleanup."""
    master, slave = pty.openpty()
    tty.setraw(slave)
    child = None
    output = bytearray()
    start = time.monotonic()
    last_read = start
    help_sent_at = None
    help_cleared_at = None
    quit_sent = False
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
                    chunk = os.read(master, min(65536, OUTPUT_LIMIT - len(output) + 1))
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    chunk = b""
                if chunk:
                    if len(chunk) + len(output) > OUTPUT_LIMIT:
                        raise AssertionError(f"Native PTY output exceeded {OUTPUT_LIMIT} bytes")
                    output.extend(chunk)
                    last_read = time.monotonic()
            if close_ink and BANNER in output:
                after_ink = bytes(output).split(BANNER, 1)[1]
                # Exercise real Ink key dispatch, not terminal escape codes
                # mistaken for paint. '?' opens pinned HelpHint with '/quit'.
                if help_sent_at is None and time.monotonic() - start > 1:
                    os.write(master, b"?")
                    help_sent_at = time.monotonic()
                if help_sent_at is not None and help_cleared_at is None and INK_HELP_MARKER in after_ink:
                    os.write(master, b"\x7f")  # Backspace the '?' draft.
                    help_cleared_at = time.monotonic()
                if help_cleared_at is not None and not quit_sent and time.monotonic() - help_cleared_at > 0.5:
                    os.write(master, b"\x04")  # Ordinary idle Ctrl+D; never Ctrl+C for success.
                    quit_sent = True
            if child.poll() is not None and time.monotonic() - last_read > 0.3:
                break
        if child.poll() is None:
            raise TimeoutError(
                f"Native PTY did not exit normally in {timeout}s; "
                f"Ink help rendered={INK_HELP_MARKER in output}, Ctrl+D sent={quit_sent}, "
                f"last bytes={bytes(output)[-1200:]!r}"
            )
        return child.wait(timeout=2), bytes(output)
    finally:
        if child is not None:
            _cleanup_owned_group(child)
        os.close(master)
        if slave >= 0:
            os.close(slave)


def _node_shim(tmp_path: Path, node: str, env: dict[str, str]) -> Path:
    """Lossless JSON argv receipt before replacing the process with REAL Node."""
    recorder = tmp_path / "node-record.py"
    recorder.write_text(
        "import json\n"
        "import os\n"
        "import sys\n"
        "from pathlib import Path\n"
        "argv = sys.argv[1:]\n"
        "if any(Path(arg).name == 'entry.js' for arg in argv):\n"
        "    keys = ('HERMES_TUI_DIR', 'HERMES_HOME', 'TERM_PROGRAM', 'TERN_PANE',\n"
        "            'HERMES_TERN_LAUNCH_CWD', 'HERMES_TERN_RESTORED',\n"
        "            'HERMES_TUI_RESUME', 'HERMES_TUI_PASS_SESSION_ID',\n"
        "            'HERMES_CWD', 'HERMES_TUI_CWD', 'TERMINAL_CWD')\n"
        "    record = {key: os.environ.get(key, '') for key in keys}\n"
        "    record.update(argv=argv, node_cwd=os.getcwd())\n"
        "    with open(os.environ['HERMES_FALLBACK_CALLS'], 'a', encoding='utf-8') as stream:\n"
        "        stream.write(json.dumps(record, ensure_ascii=False) + '\\n')\n"
        "os.execv(os.environ['HERMES_FALLBACK_REAL_NODE'],\n"
        "         [os.environ['HERMES_FALLBACK_REAL_NODE'], *argv])\n"
    )
    shim = tmp_path / "node-record"
    shim.write_text(
        "#!/bin/sh\n"
        'exec "$HERMES_FALLBACK_PYTHON" "$HERMES_FALLBACK_RECORDER" "$@"\n'
    )
    shim.chmod(0o700)
    env.update({
        "HERMES_FALLBACK_PYTHON": sys.executable,
        "HERMES_FALLBACK_RECORDER": str(recorder),
        "HERMES_FALLBACK_REAL_NODE": node,
        "HERMES_FALLBACK_CALLS": str(tmp_path / "calls.jsonl"),
        "HERMES_NODE": str(shim),
    })
    return shim


def _calls(path: Path) -> list[dict]:
    assert path.exists(), "Hermes never launched a real compiled Node entry"
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        call = json.loads(line)
        assert isinstance(call.get("argv"), list) and all(
            isinstance(x, str) for x in call["argv"]
        ), f"Not a lossless Node argument list: {call!r}"
        records.append(call)
    return records


def _hermes_driver(source: Path) -> list[str]:
    return [sys.executable, "-I", "-c", DRIVER, str(source), str(ROOT)]


def _owned_resume_fixture(tmp_path: Path, env: dict[str, str]) -> str:
    """Seed the driver-owned SessionDB, not an external session or fake pane."""
    saved = tmp_path / "resume-workspace"
    saved.mkdir()
    session_id = "local-" + uuid.uuid4().hex
    env["HERMES_FALLBACK_RESUME_ID"] = session_id
    env["HERMES_FALLBACK_RESUME_CWD"] = str(saved)
    return session_id


def _assert_real_entries(
    calls: list[dict], source: Path, env: dict[str, str], *,
    retry: bool, resume: str = "",
) -> None:
    ink = source / "hermes_cli" / "tui_dist" / "entry.js"
    expected_entries = [([ "--expose-gc", str(ENTRY)], FRONTEND)] if retry else []
    expected_entries.append((["--expose-gc", str(ink)], ink.parent))
    assert len(calls) == len(expected_entries), (
        f"Expected {'one Tern + exactly one Ink' if retry else 'only Ink'}: {calls}"
    )
    expected_cwd = env.get("HERMES_FALLBACK_RESUME_CWD", str(ROOT))
    for call, (expected_argv, node_cwd) in zip(calls, expected_entries):
        assert call["argv"] == expected_argv, calls
        assert Path(call["node_cwd"]).resolve() == node_cwd.resolve(), calls
        assert call["HERMES_TUI_DIR"] == (str(FRONTEND) if node_cwd == FRONTEND else ""), calls
        assert call["HERMES_HOME"] == env["HERMES_HOME"], calls
        assert call["TERM_PROGRAM"] == env["TERM_PROGRAM"], calls
        assert call["TERN_PANE"] == "", "No real Tern pane exists in this PTY fixture"
        assert call["HERMES_TERN_LAUNCH_CWD"] == str(ROOT), calls
        assert call["HERMES_TERN_RESTORED"] == "", "No fabricated pane restoration"
        assert call["HERMES_TUI_RESUME"] == resume, calls
        assert call["HERMES_TUI_PASS_SESSION_ID"] == "1", calls
        assert Path(call["HERMES_CWD"]).resolve() == Path(expected_cwd).resolve(), calls
        assert Path(call["HERMES_TUI_CWD"]).resolve() == Path(expected_cwd).resolve(), calls
        assert Path(call["TERMINAL_CWD"]).resolve() == Path(expected_cwd).resolve(), calls


def test_actual_compiled_entry_exits_75_without_tty(native_source, tmp_path):
    _, node = native_source
    env = _environment(tmp_path, native_source[0], node)
    code, stdout, stderr = _bounded_capture(
        [node, "--expose-gc", str(ENTRY)], cwd=FRONTEND, env=env,
    )
    assert code == 75, (code, stdout[-800:], stderr[-800:])


@pytest.mark.parametrize("markers", [
    {},
    {"SSH_CONNECTION": "fixture-only", "TERM_PROGRAM": "xterm"},
    {"TMUX": "/fixture/tmux,0,0", "TERM_PROGRAM": "tern"},
    {"STY": "fixture-screen", "TERM_PROGRAM": "tern"},
    {"ZELLIJ": "fixture-only", "TERM_PROGRAM": "tern"},
], ids=["ordinary-local-pty", "ssh-marker-only", "tmux-marker-only",
        "screen-marker-only", "zellij-marker-only"])
def test_actual_compiled_entry_fails_closed_in_non_tern_pty(native_source, tmp_path, markers):
    """Real PTYs with marker env, NOT actual SSH/multiplexer transports."""
    _, node = native_source
    env = _environment(tmp_path, native_source[0], node)
    env.update(markers)
    code, output = _pty_process(
        [node, "--expose-gc", str(ENTRY)], cwd=FRONTEND, env=env, timeout=20,
    )
    assert code == 75, (markers, code, output[-1200:])


def test_actual_launcher_retries_ink_once_without_tty(native_source, tmp_path):
    source, node = native_source
    env = _environment(tmp_path, source, node)
    resume_id = _owned_resume_fixture(tmp_path, env)
    _node_shim(tmp_path, node, env)
    code, stdout, stderr = _capture_driver(source, env)
    calls = _calls(tmp_path / "calls.jsonl")
    _assert_real_entries(calls, source, env, retry=True, resume=resume_id)
    assert stderr.count(BANNER) == 1, (code, stderr[-1500:])
    assert code == 0, (code, stdout[-1200:], stderr[-1500:])
    assert TSP_FRAME not in stderr.split(BANNER, 1)[1], "TSP APC after Ink handoff"


def test_actual_launcher_ink_paints_and_quits_cleanly_in_real_pty(native_source, tmp_path):
    source, node = native_source
    env = _environment(tmp_path, source, node)
    _node_shim(tmp_path, node, env)
    code, output = _pty_driver(source, env)
    _assert_real_entries(_calls(tmp_path / "calls.jsonl"), source, env, retry=True)
    assert output.count(BANNER) == 1, (code, output[-1500:])
    after_ink = output.split(BANNER, 1)[1]
    assert INK_HELP_MARKER in after_ink, (
        "Real Ink HelpHint did not render; qualify first-run setup in the "
        "isolated profile rather than treating arbitrary ANSI paint as success"
    )
    assert b"\x1b[" in after_ink, "No real Ink terminal frame after fallback"
    assert TSP_FRAME not in after_ink, "TSP APC escaped after Ink takeover"
    assert code == 0, (
        "Only ordinary Ctrl+D -> exit 0 qualifies clean exit; Ctrl+C/130 is "
        "not a passing fallback", code, output[-2000:],
    )


def test_explicit_ordinary_tui_uses_real_ink_without_a_tern_attempt(native_source, tmp_path):
    source, node = native_source
    env = _environment(tmp_path, source, node)
    env["HERMES_TERN"] = "0"
    _node_shim(tmp_path, node, env)
    code, stdout, stderr = _capture_driver(source, env)
    calls = _calls(tmp_path / "calls.jsonl")
    _assert_real_entries(calls, source, env, retry=False)
    assert BANNER not in stderr, stderr[-1500:]
    assert code == 0, (code, stdout[-1200:], stderr[-1200:])
    assert TSP_FRAME not in stdout + stderr, "No TSP entry was launched"
