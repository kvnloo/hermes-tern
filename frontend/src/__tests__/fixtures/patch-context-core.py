"""Exercise pinned patch warning and gateway envelope without target-file I/O."""
import json
from unittest.mock import patch

from gateway.run_turn_progress import _tool_complete_payload
from tools import file_state, file_tools


class Result:
    def to_dict(self):
        return {'success': True, 'diff': '@@ -1 +1 @@\n-before\n+after\n'}


class FileOps:
    def patch_replace(self, path, old, new, replace_all):
        assert path == '/backend/private/x.py'
        return Result()


args = {'mode': 'replace', 'path': 'x.py', 'old_string': 'before', 'new_string': 'after'}
registry = file_state.FileStateRegistry()
with patch('tools.file_state.time.time', side_effect=[1, 2]), patch('tools.file_state._mtime_or_none', return_value=1):
    registry.record_read('reader', '/backend/private/x.py', mtime=1)
    registry.note_write('sibling-secret', '/backend/private/x.py', mtime=1)
with patch.object(file_state, '_registry', registry), \
     patch('tools.file_state._mtime_or_none', return_value=1), \
     patch.object(file_tools, '_write_precheck_error', return_value=None), \
     patch.object(file_tools, '_resolve_or_none', return_value='/backend/private/x.py'), \
     patch.object(file_tools, '_get_file_ops', return_value=FileOps()), \
     patch.object(file_tools, '_known_full_content_sha256', return_value={}), \
     patch.object(file_tools, '_note_edited'), \
     patch.object(file_tools, '_carry_full_write_baselines'), \
     patch.object(file_tools, '_reset_patch_failures'):
    result = file_tools.patch_tool(**args, task_id='reader')
payload = _tool_complete_payload('patch-warning', 'patch', args, result)
print(json.dumps(payload))
