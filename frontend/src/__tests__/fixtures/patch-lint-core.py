"""Run Hermes' replace patch and lint producer with a memory-only file adapter."""
import json
from tools.file_operations import ShellFileOperations
from tools.file_operations_common import WriteResult
from tools.file_operations_lint import LintMixin


class MemoryFile:
    _unified_diff = ShellFileOperations._unified_diff

    def _expand_path(self, path):
        return path

    def _read_exact_bytes(self, path):
        return b'x = 1\n', None

    def _verify_patch_persisted(self, path, content):
        return None

    def write_file(self, path, content, pre_content=None):
        lint = LintMixin()._check_lint_delta(path, pre_content, content).to_dict()
        return WriteResult(bytes_written=len(content), verified=True, lint=lint)


f = MemoryFile()
bad = ShellFileOperations.patch_replace(f, 'x.py', 'x = 1', 'def broken(:')
clean = ShellFileOperations.patch_replace(f, 'x.py', 'x = 1', 'x = 2')
print(json.dumps([bad.to_dict(), clean.to_dict()]))
