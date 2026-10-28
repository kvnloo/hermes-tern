"""Pinned warning + no-change/validation producers through patch_tool and gateway; no target I/O."""
import json
from unittest.mock import patch

from gateway.run_turn_progress import _tool_complete_payload
from tools import file_state, file_tools
from tools.file_operations import ShellFileOperations
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


class FileOps:
    def __init__(self):
        self.memory = MemoryFile()

    def patch_replace(self, path, old, new, replace_all):
        return ShellFileOperations(None)._no_match_result(path, 'new target text is already here', old, new, 0, None)

    def patch_v4a(self, content):
        operations, error = parse_v4a_patch(content)
        if error:
            raise ValueError(error)
        return apply_v4a_operations(operations, self.memory)


registry = file_state.FileStateRegistry()
with patch('tools.file_state.time.time', side_effect=[1, 2]), patch('tools.file_state._mtime_or_none', return_value=1):
    registry.record_read('reader', '/backend/private/x.py', mtime=1)
    registry.note_write('sibling-secret', '/backend/private/x.py', mtime=1)

fake = FileOps()
noop = {'mode': 'replace', 'path': 'x.py', 'old_string': 'previous text', 'new_string': 'new target text'}
v4a = {'mode': 'patch', 'patch': '*** Begin Patch\n*** Update File: x.py\n@@\n-no such text\n+new text\n*** End Patch\n'}
with patch.object(file_state, '_registry', registry), \
     patch('tools.file_state._mtime_or_none', return_value=1), \
     patch.object(file_tools, '_write_precheck_error', return_value=None), \
     patch.object(file_tools, '_resolve_or_none', return_value='/backend/private/x.py'), \
     patch.object(file_tools, '_get_file_ops', return_value=fake), \
     patch.object(file_tools, '_known_full_content_sha256', return_value={}), \
     patch.object(file_tools, '_rewrite_v4a_patch_paths_for_host', side_effect=lambda content, *args: content), \
     patch.object(file_tools, '_note_edited'), \
     patch.object(file_tools, '_carry_full_write_baselines'), \
     patch.object(file_tools, '_reset_patch_failures'):
    noop_result = file_tools.patch_tool(**noop, task_id='reader')
    v4a_result = file_tools.patch_tool(**v4a, task_id='reader')

print(json.dumps({
    'noop': _tool_complete_payload('warning-noop', 'patch', noop, noop_result),
    'validation': _tool_complete_payload('warning-validation', 'patch', v4a, v4a_result),
    'writes': fake.memory.writes,
}))
