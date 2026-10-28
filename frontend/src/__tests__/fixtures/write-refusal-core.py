"""Pinned structured-format pre-write refusal + gateway envelope, without a target file."""
import json
from gateway.run_turn_progress import _tool_complete_payload
from tools.file_operations import ShellFileOperations

args = {'path': 'x.json', 'content': '{bad json'}
result = ShellFileOperations._fail_closed_syntax_error(args['path'], '.json', args['content'])
if result is None:
    raise RuntimeError('expected a fail-closed refusal')
print(json.dumps(_tool_complete_payload('write', 'write_file', args, json.dumps(result.to_dict()))))
