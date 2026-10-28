"""Pinned V4A producer plus gateway envelope, with memory-only file operations."""
import json
from gateway.run_turn_progress import _tool_complete_payload
from tools.file_operations_common import LintResult, ReadResult, WriteResult
from tools.patch_parser import apply_v4a_operations, parse_v4a_patch

PATCH = '''*** Begin Patch
*** Update File: x.py
@@
-x = 1
+x = 42
*** Update File: y.py
@@
-y = 2
+y = 3
*** End Patch
'''

class Files:
    def __init__(self, lint):
        self.files = {'x.py': 'x = 1\n', 'y.py': 'y = 2\n'}
        self.lint = lint

    def read_file_raw(self, path):
        return ReadResult(content=self.files[path])

    def write_file(self, path, content, pre_content=None):
        if path == 'y.py':
            return WriteResult(error='write refused')
        self.files[path] = content
        return WriteResult(bytes_written=len(content), verified=True,
                           lint=LintResult().to_dict() if self.lint else None)

operations, error = parse_v4a_patch(PATCH)
if error:
    raise ValueError(error)
args = {'mode': 'patch', 'patch': PATCH}
print(json.dumps([_tool_complete_payload('patch-' + str(with_lint), 'patch', args,
                 json.dumps(apply_v4a_operations(operations, Files(with_lint)).to_dict()))
                  for with_lint in (False, True)]))
