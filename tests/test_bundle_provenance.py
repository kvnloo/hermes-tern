import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "bundle_provenance", Path(__file__).resolve().parents[1] / "scripts/bundle_provenance.py"
)
provenance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provenance)


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=Bundle test", "-c", "user.email=bundle@example.invalid", *args],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    ).stdout.strip()


class BundleProvenanceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.hermes = self.root / "hermes"
        self.plugin = self.root / "plugin"
        for repo in (self.plugin, self.hermes):
            repo.mkdir()
            git(repo, "init", "-q")
        (self.hermes / "source").write_text("source\n")
        git(self.hermes, "add", ".")
        git(self.hermes, "commit", "-qm", "Hermes source")
        self.hermes_sha = git(self.hermes, "rev-parse", "HEAD")
        (self.plugin / "frontend").mkdir()
        (self.plugin / "frontend/hermes-src.lock").write_text(self.hermes_sha + "\n")
        (self.plugin / ".gitignore").write_text("frontend/.hermes-src\n")
        (self.plugin / "source").write_text("plugin\n")
        git(self.plugin, "add", ".")
        git(self.plugin, "commit", "-qm", "Plugin source")
        self.plugin_sha = git(self.plugin, "rev-parse", "HEAD")
        (self.plugin / "frontend/.hermes-src").symlink_to(self.hermes, target_is_directory=True)
        self.bundle = self.root / "entry.js"
        self.bundle.write_bytes(b"fresh build\n")
        self.output = self.root / "provenance.json"

    def verify(self):
        return provenance.verify(self.plugin, self.hermes, self.plugin_sha)

    def test_receipt_binds_bundle_and_source_revisions(self):
        provenance.receipt(self.plugin, self.hermes, self.plugin_sha, self.bundle, self.output)
        self.assertEqual(json.loads(self.output.read_text()), {
            "schema": 1,
            "plugin_sha": self.plugin_sha,
            "hermes_sha": self.hermes_sha,
            "bundle_sha256": "8dcf11c562d77a596f389d72d205900e8e738d434d46a10de1e40ed02f2254ed",
            "bundle_size_bytes": 12,
        })

    def test_wrong_plugin_revision_refuses_receipt(self):
        with self.assertRaises(ValueError):
            provenance.receipt(self.plugin, self.hermes, "0" * 40, self.bundle, self.output)
        self.assertFalse(self.output.exists())

    def test_dirty_or_staged_inputs_refuse_build(self):
        (self.plugin / "source").write_text("changed\n")
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        git(self.plugin, "add", "source")
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        git(self.plugin, "reset", "--hard", "-q", "HEAD")
        (self.hermes / "source").write_text("changed\n")
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()

    def test_changed_hermes_head_and_wrong_link_are_rejected(self):
        (self.hermes / "source").write_text("new\n")
        git(self.hermes, "add", "source")
        git(self.hermes, "commit", "-qm", "new Hermes")
        with self.assertRaises(ValueError):
            self.verify()
        git(self.hermes, "reset", "--hard", "-q", self.hermes_sha)
        (self.plugin / "frontend/.hermes-src").unlink()
        (self.plugin / "frontend/.hermes-src").symlink_to(self.plugin, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.verify()

    def test_invalid_pin_and_missing_empty_or_symlink_bundle_are_rejected(self):
        lock = self.plugin / "frontend/hermes-src.lock"
        lock.write_text(self.hermes_sha + "\nextra\n")
        with self.assertRaises(ValueError):
            provenance.pin(lock)
        lock.write_text(self.hermes_sha + "\n")
        self.bundle.unlink()
        with self.assertRaises(ValueError):
            provenance.receipt(self.plugin, self.hermes, self.plugin_sha, self.bundle, self.output)
        self.bundle.write_bytes(b"")
        with self.assertRaises(ValueError):
            provenance.receipt(self.plugin, self.hermes, self.plugin_sha, self.bundle, self.output)
        self.bundle.unlink()
        self.bundle.symlink_to(self.plugin / "source")
        with self.assertRaises(ValueError):
            provenance.receipt(self.plugin, self.hermes, self.plugin_sha, self.bundle, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
