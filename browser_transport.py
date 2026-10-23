"""Window-pinned Tern CLI transport. No daemon discovery or alternate browser routing.

Adapted from Hermes ui-tsp/tools/browser_tern_transport.py and the Tern browser
JSON protocol. An indeterminate open retains its subprocess and quarantines
the window until the exact reply can be reconciled.
"""
from __future__ import annotations

import json
import subprocess


class NativeBrowserError(RuntimeError):
    """A bounded, secret-safe native failure; never carry CLI stderr or URLs."""

    def __init__(self, kind: str = "failed"):
        self.kind = kind if kind in {
            "failed", "timeout", "open_pending", "open_unknown", "unsupported",
            "invalid", "no_window", "not_found", "closed", "ownership", "busy",
            "unavailable", "js", "protocol",
        } else "failed"
        super().__init__(f"Tern browser {self.kind}")


def exact_block(answer: object) -> int:
    if not isinstance(answer, dict):
        raise NativeBrowserError("protocol")
    block = answer.get("block")
    if type(block) is not int or block <= 0:
        raise NativeBrowserError("open_unknown")
    return block


class TernBrowserCLI:
    def __init__(self, executable: str, env: dict[str, str], window: str, timeout: float = 35):
        self.executable = executable
        self.env = dict(env)
        self.window = window
        self.timeout = timeout
        self.pending: subprocess.Popen | None = None
        self.unknown = False

    @staticmethod
    def _answer(code: int, stdout: str, *, unwrap: bool = True) -> dict:
        if code == 124:
            raise NativeBrowserError("timeout")
        try:
            value = json.loads(stdout)
        except (TypeError, ValueError) as exc:
            raise NativeBrowserError("protocol") from exc
        if not isinstance(value, dict):
            raise NativeBrowserError("protocol")
        if code or "error" in value:
            error = value.get("error")
            kind = error.get("kind") if isinstance(error, dict) else "failed"
            raise NativeBrowserError(kind if isinstance(kind, str) else "failed")
        result = value.get("ok", value)
        if unwrap and not isinstance(result, dict):
            raise NativeBrowserError("protocol")
        return result if isinstance(result, dict) else {}

    def invoke(self, argv: list[str]) -> dict:
        if self.unknown:
            raise NativeBrowserError("open_unknown")
        if self.pending is not None:
            raise NativeBrowserError("open_pending")
        try:
            done = subprocess.run(
                [self.executable, *argv, "--window", self.window], env=self.env,
                text=True, capture_output=True, timeout=self.timeout, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise NativeBrowserError("timeout") from exc
        except OSError as exc:
            raise NativeBrowserError("unavailable") from exc
        return self._answer(done.returncode, done.stdout, unwrap=argv[0] == "browser")

    def __call__(self, op: dict) -> dict:
        if op.get("op") != "open":
            return self.invoke(["browser", json.dumps(op, separators=(",", ":")), "--timeout", "30"])
        if self.pending is not None or self.unknown:
            raise NativeBrowserError("open_unknown")
        try:
            self.pending = subprocess.Popen(
                [self.executable, "browser", json.dumps(op, separators=(",", ":")),
                 "--timeout", "300", "--window", self.window],
                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            stdout, _ = self.pending.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired as exc:
            # communicate(timeout) does not terminate the client. Only its definitive
            # later answer may identify the page to clean.
            raise NativeBrowserError("open_pending") from exc
        except OSError as exc:
            self.pending = None
            raise NativeBrowserError("unavailable") from exc
        return self._finish_open(stdout)

    def _finish_open(self, stdout: str) -> dict:
        process = self.pending
        if process is None:
            raise NativeBrowserError("open_unknown")
        self.pending = None
        try:
            return self._answer(process.returncode, stdout)
        except NativeBrowserError as exc:
            self.unknown = exc.kind not in {"unsupported", "invalid", "no_window"}
            raise

    def reconcile_open(self) -> dict:
        if self.unknown:
            raise NativeBrowserError("open_unknown")
        if self.pending is None:
            raise NativeBrowserError("open_unknown")
        if self.pending.poll() is None:
            raise NativeBrowserError("open_pending")
        try:
            stdout, _ = self.pending.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired as exc:
            raise NativeBrowserError("open_pending") from exc
        return self._finish_open(stdout)
