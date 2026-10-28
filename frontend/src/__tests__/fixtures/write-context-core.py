"""Pinned warning and completion envelope; no target-file access."""
import json
import sys
from unittest.mock import patch

from gateway.run_turn_progress import _tool_complete_payload
from tools import file_state, file_tools
from tools.file_operations_common import WriteResult


class FileOps:
    def write_file(self, path, content):
        assert path == '/backend/private/x.py'
        if sys.argv[1] == 'error':
            return WriteResult(error='Synthetic write failure at /backend/private/x.py')
        return WriteResult(bytes_written=len(content), verified=True)


args = {'path': 'x.py', 'content': 'proposed content'}
registry = file_state.FileStateRegistry()
with patch.object(file_state, '_registry', registry), \
     patch.object(file_tools, '_check_sensitive_path', return_value=None), \
     patch.object(file_tools, '_check_binary_document_write', return_value=None), \
     patch.object(file_tools, '_check_protected_instruction_write', return_value=None), \
     patch.object(file_tools, '_check_approval_required_write', return_value=None), \
     patch.object(file_tools, '_check_cross_profile_path', return_value=None), \
     patch.object(file_tools, '_resolve_or_none', return_value='/backend/private/x.py'), \
     patch('tools.file_tools_write_guards._read_mtime_drifted', return_value=False), \
     patch('tools.file_tools_write_guards._has_full_write_baseline', return_value=True), \
     patch.object(file_tools, '_check_file_staleness', return_value=None), \
     patch('tools.file_tools_paths._terminal_env_type_for_task', return_value='local'), \
     patch('tools.file_tools_paths._authoritative_workspace_root', return_value='/synthetic/workspace'), \
     patch('tools.file_tools_paths._uses_container_paths', return_value=False), \
     patch.object(file_tools, '_whole_file_rewrite_hint', return_value=None), \
     patch.object(file_tools, '_get_file_ops', return_value=FileOps()), \
     patch.object(file_tools, '_note_edited'), \
     patch.object(file_tools, '_update_read_timestamp'), \
     patch.object(file_tools, '_mark_full_write_baseline'):
    result = file_tools.write_file_tool(**args, task_id='reader')
print(json.dumps(_tool_complete_payload('write-warning', 'write_file', args, result)))
