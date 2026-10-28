"""Run pinned V4A + syntax lint against a memory-only adapter."""
import json
from tools.file_operations_common import ReadResult, WriteResult
from tools.file_operations_lint import LintMixin
from tools.patch_parser import apply_v4a_operations, parse_v4a_patch


class MemoryFiles:
    def __init__(self, fail=False, omit_second=False):
        self.data = {'x.py': 'x = 1\n', 'y.py': 'y = 2\n'}
        self.fail = fail
        self.omit_second = omit_second
        self.writes = 0

    def read_file_raw(self, path):
        return ReadResult(content=self.data[path])

    def write_file(self, path, content, pre_content=None):
        if self.fail and path == 'y.py':
            return WriteResult(error='write refused')
        self.writes += 1
        self.data[path] = content
        lint = None if self.omit_second and self.writes == 2 else LintMixin()._check_lint_delta(path, pre_content, content).to_dict()
        return WriteResult(bytes_written=len(content), verified=True, lint=lint)


def apply(patch, files):
    operations, error = parse_v4a_patch(patch)
    if error:
        raise ValueError(error)
    return apply_v4a_operations(operations, files).to_dict()


multi = '''*** Begin Patch
*** Update File: x.py
@@
-x = 1
+def broken(:
*** Update File: y.py
@@
-y = 2
+y = 3
*** End Patch
'''
duplicate = '''*** Begin Patch
*** Update File: x.py
@@
-x = 1
+def broken(:
*** Update File: x.py
@@
-def broken(:
+x = 2
*** End Patch
'''
print(json.dumps([apply(multi, MemoryFiles()), apply(multi, MemoryFiles(fail=True)),
                  apply(duplicate, MemoryFiles()), apply(duplicate, MemoryFiles(omit_second=True))]))
