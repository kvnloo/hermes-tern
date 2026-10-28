"""Fail-closed provenance and result gate for the pinned-Hermes checks workflow.

No network, credentials or third-party packages are needed for its negative controls.
The workflow invokes this module against actual Git checkouts and JUnit test output.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock
from xml.etree import ElementTree

FULL_SHA = re.compile(r"[0-9a-f]{40}\Z")


class ContractFailure(ValueError):
    """A pin, checkout, dependency-install or result contract was not met."""


def exact_sha(value: str) -> str:
    if not FULL_SHA.fullmatch(value):
        raise ContractFailure(f"expected a lowercase full Git SHA, got {value!r}")
    return value


def pinned_sha(lock: Path) -> str:
    try:
        raw = lock.read_text(encoding="utf-8")
    except OSError as exc:
        raise ContractFailure(f"cannot read pin {lock}: {exc}") from exc
    # Only a SHA and its optional terminating newline are legal; no moving refs.
    if not re.fullmatch(r"[0-9a-f]{40}\n?", raw):
        raise ContractFailure(f"invalid or unavailable runtime pin: {lock}")
    return exact_sha(raw.strip())


def checkout_sha(repo: Path) -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            text=True,
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ContractFailure(f"cannot resolve Git checkout {repo}: {exc}") from exc
    return exact_sha(completed.stdout.strip())


def require_checkout(repo: Path, expected: str) -> str:
    actual = checkout_sha(repo)
    if actual != exact_sha(expected):
        raise ContractFailure(f"{repo}: checkout {actual} does not match declared Hermes/plugin {expected}")
    return actual


def load_receipt(file: Path) -> dict:
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ContractFailure(f"missing or invalid CI receipt {file}: {exc}") from exc
    if not isinstance(data, dict):
        raise ContractFailure("CI receipt is not an object")
    return data


def save_receipt(file: Path, receipt: dict) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def verify_results(receipt: dict, junit: Path) -> int:
    # Even an invented/leftover green JUnit file cannot forgive a broken install.
    if receipt.get("checkout") != "PASS" or receipt.get("install") != "PASS":
        raise ContractFailure("tests cannot PASS without verified checkout and installed locked dependencies")
    try:
        root = ElementTree.parse(junit).getroot()
    except (OSError, ElementTree.ParseError) as exc:
        raise ContractFailure(f"missing or invalid test result {junit}: {exc}") from exc
    if root.tag not in ("testsuite", "testsuites"):
        raise ContractFailure("not a JUnit test-suite result")
    cases = list(root.iter("testcase"))
    if not cases:
        raise ContractFailure("no test cases executed")
    # Some JUnit producers report errors only on the suite (for example, a
    # collection error). Do not let a green child hide a contradictory summary.
    for suite in root.iter():
        if suite.tag not in ("testsuite", "testsuites"):
            continue
        counts = {}
        for name in ("tests", "failures", "errors", "skipped"):
            raw = suite.get(name)
            if raw is None:
                continue
            if not re.fullmatch(r"[0-9]+", raw):
                raise ContractFailure(f"invalid JUnit {name} counter: {raw!r}")
            count = int(raw)
            counts[name] = count
            # pytest can count unittest subtests without emitting a separate
            # testcase for each one. A summary may overcount, never undercount.
            if name == "tests" and count < len(list(suite.iter("testcase"))):
                raise ContractFailure("JUnit test count is smaller than its cases")
            if name in ("failures", "errors") and count:
                raise ContractFailure(f"JUnit suite reports {count} {name}")
        if "tests" in counts and "skipped" in counts:
            if counts["skipped"] > counts["tests"]:
                raise ContractFailure("JUnit skipped count exceeds test count")
            if counts["tests"] and counts["skipped"] == counts["tests"] and any(
                case.find("skipped") is None for case in suite.iter("testcase")
            ):
                raise ContractFailure("JUnit suite says all tests were skipped but contains an unskipped case")
    failures = sum(
        any(case.find(tag) is not None for tag in ("failure", "error"))
        for case in cases
    )
    passed = sum(
        all(case.find(tag) is None for tag in ("failure", "error", "skipped"))
        for case in cases
    )
    if failures or not passed:
        raise ContractFailure(f"JUnit is not green: {failures} failures/errors; {passed} passed")
    return passed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)

    pin = sub.add_parser("pin")
    pin.add_argument("--lock", type=Path, required=True)

    check = sub.add_parser("require")
    check.add_argument("--repo", type=Path, required=True)
    check.add_argument("--sha", required=True)

    init = sub.add_parser("init")
    init.add_argument("--receipt", type=Path, required=True)
    init.add_argument("--plugin", required=True)
    init.add_argument("--hermes", required=True)
    init.add_argument("--kind", choices=("runtime-pin", "test-only-core"), required=True)
    init.add_argument("--command", action="append", required=True)

    checkout = sub.add_parser("checkout")
    checkout.add_argument("--receipt", type=Path, required=True)
    checkout.add_argument("--repo", type=Path, required=True)
    checkout.add_argument("--pin-file", type=Path)

    installed = sub.add_parser("installed")
    installed.add_argument("--receipt", type=Path, required=True)
    installed.add_argument("--repo", type=Path, required=True)
    installed.add_argument("--marker", type=Path, action="append", required=True)

    result = sub.add_parser("result")
    result.add_argument("--receipt", type=Path, required=True)
    result.add_argument("--repo", type=Path, required=True)
    result.add_argument("--junit", type=Path, required=True)

    stage = sub.add_parser("stage")
    stage.add_argument("--receipt", type=Path, required=True)
    stage.add_argument("--what", choices=("controls", "bundle"), required=True)

    args = parser.parse_args()
    try:
        if args.operation == "pin":
            print(pinned_sha(args.lock))
            return
        if args.operation == "require":
            print(require_checkout(args.repo, args.sha))
            return
        if args.operation == "init":
            actual_plugin = require_checkout(Path("."), args.plugin)
            save_receipt(args.receipt, {
                "plugin_head": actual_plugin,
                "hermes_sha": exact_sha(args.hermes),
                "hermes_kind": args.kind,
                "commands": args.command,
                "checkout": "NOT_RUN",
                "install": "NOT_RUN",
                "tests": "NOT_RUN",
                "controls": "NOT_RUN",
                "bundle": "NOT_RUN",
            })
            return
        receipt = load_receipt(args.receipt)
        if args.operation == "checkout":
            if args.pin_file and pinned_sha(args.pin_file) != receipt.get("hermes_sha"):
                raise ContractFailure("lock changed between read and checkout")
            receipt["observed_hermes_sha"] = require_checkout(args.repo, receipt["hermes_sha"])
            receipt["checkout"] = "PASS"
        elif args.operation == "installed":
            if receipt.get("checkout") != "PASS":
                raise ContractFailure("cannot pass installation before checkout verification")
            require_checkout(args.repo, receipt["hermes_sha"])
            missing = [str(p) for p in args.marker if not p.exists()]
            if missing:
                raise ContractFailure(f"locked installation missing expected output: {', '.join(missing)}")
            receipt["install"] = "PASS"
        elif args.operation == "result":
            require_checkout(args.repo, receipt["hermes_sha"])
            receipt["passed_cases"] = verify_results(receipt, args.junit)
            receipt["tests"] = "PASS"
        elif args.operation == "stage":
            if args.what == "bundle" and receipt.get("tests") != "PASS":
                raise ContractFailure("bundle gate requires a passing test result")
            receipt[args.what] = "PASS"
        save_receipt(args.receipt, receipt)
    except ContractFailure as exc:
        print(f"::error::{exc}", file=sys.stderr)
        sys.exit(1)


class OfflineNegativeControls(unittest.TestCase):
    def check_junit(self, xml: str) -> int:
        with tempfile.TemporaryDirectory() as root:
            result = Path(root) / "result.xml"
            result.write_text(xml, encoding="utf-8")
            return verify_results({"checkout": "PASS", "install": "PASS"}, result)

    def test_invalid_runtime_pin_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            lock = Path(root) / "hermes-src.lock"
            for invalid in ("main\n", "a" * 39 + "\n", "a" * 40 + "\nextra\n", ""):
                lock.write_text(invalid, encoding="utf-8")
                with self.subTest(invalid=invalid), self.assertRaises(ContractFailure):
                    pinned_sha(lock)

    def test_mismatched_revision_fails_closed(self):
        sha = "b" * 40
        with mock.patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, sha + "\n")):
            with self.assertRaises(ContractFailure):
                require_checkout(Path(".hermes-agent"), "a" * 40)

    def test_failed_install_cannot_become_passing_tests(self):
        with tempfile.TemporaryDirectory() as root:
            xml = Path(root) / "ok.xml"
            xml.write_text('<testsuite><testcase name="ran"/></testsuite>', encoding="utf-8")
            with self.assertRaises(ContractFailure):
                verify_results({"checkout": "PASS", "install": "FAIL"}, xml)
            with self.assertRaises(ContractFailure):
                verify_results({"checkout": "PASS", "install": "NOT_RUN"}, xml)

    def test_missing_or_empty_test_result_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            receipt = {"checkout": "PASS", "install": "PASS"}
            with self.assertRaises(ContractFailure):
                verify_results(receipt, Path(root) / "missing.xml")
            empty = Path(root) / "empty.xml"
            empty.write_text("<testsuite tests=\"0\"/>", encoding="utf-8")
            with self.assertRaises(ContractFailure):
                verify_results(receipt, empty)

    def test_positive_nonempty_result(self):
        with tempfile.TemporaryDirectory() as root:
            xml = Path(root) / "ok.xml"
            xml.write_text('<testsuite><testcase name="real-case"/></testsuite>', encoding="utf-8")
            self.assertEqual(verify_results({"checkout": "PASS", "install": "PASS"}, xml), 1)

    def test_suite_summary_must_agree_with_cases(self):
        for xml in (
            '<testsuite tests="1" failures="1"><testcase/></testsuite>',
            '<testsuite tests="0"><testcase/></testsuite>',
            '<testsuites tests="1"><testsuite tests="1" errors="1"><testcase/></testsuite></testsuites>',
            '<testsuite tests="bogus"><testcase/></testsuite>',
            '<testsuite tests="1" skipped="1"><testcase/></testsuite>',
            '<testsuite tests="1" skipped="2"><testcase/></testsuite>',
        ):
            with self.subTest(xml=xml), self.assertRaises(ContractFailure):
                self.check_junit(xml)
        self.assertEqual(self.check_junit(
            '<testsuites tests="2" failures="0" errors="0"><testsuite tests="2" failures="0" errors="0">'
            '<testcase/><testcase><skipped/></testcase></testsuite></testsuites>'
        ), 1)
        # pytest includes unittest subtests in tests= but not in testcase elements.
        self.assertEqual(self.check_junit('<testsuite tests="2"><testcase/></testsuite>'), 1)

    def test_malformed_result_fails_closed(self):
        with self.assertRaises(ContractFailure):
            self.check_junit('<testsuite><testcase>')

    def test_plugin_head_mismatch_rejects_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            receipt = Path(root) / 'receipt.json'
            args = ['contract', 'init', '--receipt', str(receipt), '--plugin', 'a' * 40,
                    '--hermes', 'b' * 40, '--kind', 'runtime-pin', '--command', 'test']
            with mock.patch.object(sys, 'argv', args), mock.patch('sys.stderr'):
                with mock.patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'c' * 40 + '\n')):
                    with self.assertRaises(SystemExit):
                        main()
            self.assertFalse(receipt.exists())

    def test_missing_install_marker_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            receipt = Path(root) / 'receipt.json'
            save_receipt(receipt, {'checkout': 'PASS', 'install': 'NOT_RUN', 'hermes_sha': 'a' * 40})
            args = ['contract', 'installed', '--receipt', str(receipt), '--repo', root,
                    '--marker', str(Path(root) / 'missing')]
            with mock.patch.object(sys, 'argv', args), mock.patch('sys.stderr'):
                with mock.patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'a' * 40 + '\n')):
                    with self.assertRaises(SystemExit):
                        main()
            self.assertEqual(load_receipt(receipt)['install'], 'NOT_RUN')

    def test_bundle_requires_passing_tests(self):
        with tempfile.TemporaryDirectory() as root:
            receipt = Path(root) / 'receipt.json'
            save_receipt(receipt, {'tests': 'NOT_RUN', 'bundle': 'NOT_RUN'})
            args = ['contract', 'stage', '--receipt', str(receipt), '--what', 'bundle']
            with mock.patch.object(sys, 'argv', args), mock.patch('sys.stderr'):
                with self.assertRaises(SystemExit):
                    main()
            self.assertEqual(load_receipt(receipt)['bundle'], 'NOT_RUN')

    def test_source_only_guard_fails_closed_on_diff_error(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/checks.yml').read_text()
        block = workflow.split('      - name: the pull request leaves dist/entry.js alone\n', 1)[1]
        script = textwrap.dedent(block.split('        run: |\n', 1)[1])
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            git = directory / 'git'
            git.write_text('#!/bin/sh\nprintf "%s\\n" "$DIFF_OUTPUT"\nexit "$DIFF_STATUS"\n')
            git.chmod(0o755)
            grep = directory / 'grep'
            grep.write_text('#!/bin/sh\nif [ "$GREP_ERROR" = 1 ]; then exit 2; fi\nexec /usr/bin/grep "$@"\n')
            grep.chmod(0o755)
            for status, output, grep_error, expected in (
                ('1', '', '0', False),
                ('0', 'frontend/dist/entry.js', '0', False),
                ('0', 'frontend/src/a.ts', '0', True),
                ('0', 'frontend/src/a.ts', '1', False),
            ):
                env = {'PATH': f'{directory}:/usr/bin:/bin', 'BASE': 'base', 'RUNNER_TEMP': root,
                       'DIFF_STATUS': status, 'DIFF_OUTPUT': output, 'GREP_ERROR': grep_error}
                result = subprocess.run(['bash', '-e', '-c', script], env=env, capture_output=True)
                with self.subTest(status=status, output=output, grep_error=grep_error):
                    self.assertEqual(result.returncode == 0, expected, result.stderr)


if __name__ == "__main__":
    main()
