"""Emit pinned Hermes read stub and budget results under an isolated home."""
import json
import os
import tempfile

home = tempfile.TemporaryDirectory(prefix='hermes-read-status-')
os.environ['HERMES_HOME'] = home.name

from tools.file_operations_common import ReadResult
from tools.file_tools import _apply_char_budget, _dedup_stub_or_block

stub = json.loads(_dedup_stub_or_block({'dedup_hits': {}}, ('file.py', 1, 2), 'file.py'))
page = ReadResult(content='1|abc\n2|def\n3|ghi', total_lines=3).to_dict()
_apply_char_budget(page, page['content'], 1, 3, 9)
clamped = ReadResult(content='1|abcdefghij', total_lines=1).to_dict()
_apply_char_budget(clamped, clamped['content'], 1, 1, 5)
ordinary = ReadResult(content='1|abc', total_lines=4, truncated=True).to_dict()
line = ReadResult(content='1|abc... [truncated]', total_lines=1, truncated_lines=True).to_dict()
print(json.dumps([stub, page, clamped, ordinary, line]))
home.cleanup()
