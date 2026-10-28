"""Pinned V4A validation refusal and gateway envelope, with no disk writes."""
import json
from gateway.run_turn_progress import _tool_complete_payload
from tools.file_operations_common import ReadResult
from tools.patch_parser import apply_v4a_operations, parse_v4a_patch


class MemoryFile:
    def __init__(self):
        self.writes = 0

    def read_file_raw(self, path):
        return ReadResult(content='x = 1\n')

    def write_file(self, path, content, pre_content=None):
        self.writes += 1
        raise AssertionError('validation must not write')


patch = '''*** Begin Patch
*** Update File: x.py
@@
-no such text
+new text
*** End Patch
'''
ops, error = parse_v4a_patch(patch)
if error:
    raise ValueError(error)
files = MemoryFile()
result = apply_v4a_operations(ops, files).to_dict()
payload = _tool_complete_payload('refusal', 'patch', {'mode': 'patch', 'patch': patch}, json.dumps(result))
print(json.dumps({'payload': payload, 'writes': files.writes}))
