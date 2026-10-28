"""Check a bundle's immutable source inputs and record its digest.

This receipt describes a build, not its tests, release approval, or installation.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


SHA = re.compile(r"[0-9a-f]{40}\Z")


def pin(path: Path) -> str:
    value = path.read_text(encoding="utf-8").strip()
    if not SHA.fullmatch(value):
        raise ValueError("Hermes pin must be one full lowercase commit SHA")
    return value


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    ).stdout.strip()


def verify(plugin: Path, hermes: Path, expected: str) -> str:
    if not SHA.fullmatch(expected):
        raise ValueError("expected plugin revision must be a full lowercase commit SHA")
    plugin, hermes = plugin.resolve(strict=True), hermes.resolve(strict=True)
    if git(plugin, "rev-parse", "HEAD") != expected:
        raise ValueError("plugin checkout does not match the selected revision")
    wanted = pin(plugin / "frontend/hermes-src.lock")
    if git(hermes, "rev-parse", "HEAD") != wanted:
        raise ValueError("Hermes checkout does not match the pinned revision")
    if (plugin / "frontend/.hermes-src").resolve(strict=True) != hermes:
        raise ValueError("frontend source link does not point to the pinned checkout")
    for repo in (plugin, hermes):
        # HEAD compares both staged and unstaged tracked changes. Generated files
        # in ignored dependency directories do not affect this check.
        git(repo, "diff", "--quiet", "HEAD", "--")
    return wanted


def receipt(plugin: Path, hermes: Path, expected: str, bundle: Path, output: Path) -> None:
    wanted = verify(plugin, hermes, expected)
    if bundle.is_symlink() or not bundle.is_file():
        raise ValueError("bundle must be a regular file")
    data = bundle.read_bytes()
    if not data:
        raise ValueError("bundle is empty")
    record = {
        "schema": 1,
        "plugin_sha": expected,
        "hermes_sha": wanted,
        "bundle_sha256": hashlib.sha256(data).hexdigest(),
        "bundle_size_bytes": len(data),
    }
    output.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    lock = commands.add_parser("pin")
    lock.add_argument("path", type=Path)
    for name in ("verify", "receipt"):
        command = commands.add_parser(name)
        command.add_argument("--plugin", type=Path, required=True)
        command.add_argument("--hermes", type=Path, required=True)
        command.add_argument("--expected", required=True)
        if name == "receipt":
            command.add_argument("--bundle", type=Path, required=True)
            command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "pin":
            print(pin(args.path))
        elif args.command == "verify":
            verify(args.plugin, args.hermes, args.expected)
        else:
            receipt(args.plugin, args.hermes, args.expected, args.bundle, args.output)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"bundle provenance: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
