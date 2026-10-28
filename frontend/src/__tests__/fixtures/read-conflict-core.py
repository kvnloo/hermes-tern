"""Run the pinned read producer with synthetic content and no target I/O."""
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

home = tempfile.TemporaryDirectory(prefix='hermes-read-conflict-')
os.environ['HERMES_HOME'] = home.name

from gateway.run_turn_progress import _tool_complete_payload
from tools.file_operations_common import ReadResult
from tools import file_tools


class FakeOps:
    def __init__(self, content):
        self.content = content

    def read_file(self, path, offset, limit):
        return ReadResult(content=self.content, total_lines=5)


def produce(content, task):
    ops = FakeOps(content)
    with patch.object(file_tools, '_get_file_ops', return_value=ops), \
         patch.object(file_tools, '_file_ops_uses_host_paths', return_value=False), \
         patch.object(file_tools, '_resolve_base_dir', return_value=Path('/synthetic')), \
         patch.object(file_tools, '_resolve_path_for_task', return_value=Path('/synthetic/example.py')), \
         patch.object(file_tools, '_is_blocked_device', return_value=False), \
         patch.object(file_tools, 'get_read_block_error', return_value=None), \
         patch.object(file_tools, '_read_extracted_document', return_value=None), \
         patch.object(file_tools, '_check_not_found_cache', return_value=None), \
         patch.object(file_tools, '_record_successful_read', return_value=1), \
         patch.object(file_tools, 'is_background_review', return_value=False):
        result = file_tools.read_file_tool('example.py', task_id=task)
    return _tool_complete_payload(task, 'read_file', {'path': 'example.py'}, result)


valid = '1|<<<<<<< HEAD\n2|old\n3|=======\n4|new\n5|>>>>>>> other'
reverse = '1|>>>>>>> other\n2|noise\n3|<<<<<<< HEAD'
lone = '1|<<<<<<< HEAD\n2|old'
print(json.dumps([produce(valid, 'valid'), produce(reverse, 'reverse'), produce(lone, 'lone')]))
home.cleanup()
