"""Pinned stale guard and canonical envelope; no target file is opened."""
import json
from gateway.run_turn_progress import _tool_complete_payload
from tools.file_tools_write_guards import _stale_write_refusal

args = {'path': 'x.py', 'content': 'proposed content'}
result = _stale_write_refusal(args['path'], 'synthetic stale reason', '/private/backend/x.py')
print(json.dumps(_tool_complete_payload('stale', 'write_file', args, json.dumps(result))))
