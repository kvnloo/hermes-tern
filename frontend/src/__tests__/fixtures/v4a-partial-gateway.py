"""Pinned partial producer and gateway envelope, using only memory-backed files."""
import contextlib
import io
import json
import runpy
import sys

from gateway.run_turn_progress import _tool_complete_payload

out = io.StringIO()
with contextlib.redirect_stdout(out):
    runpy.run_path(sys.argv[1])
partial = json.loads(out.getvalue())[1]
args = {'mode': 'patch', 'patch': '*** Begin Patch\n*** End Patch'}
print(json.dumps(_tool_complete_payload('partial', 'patch', args, json.dumps(partial))))
