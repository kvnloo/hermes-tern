"""Emit actual pinned stdout truncation output without executing code or writing spills."""
import json

import tools.code_execution_tool as core

core._spill_full_stdout = lambda text: None
output, metadata = core._truncate_stdout_text('a' * (core.MAX_STDOUT_BYTES + 32))
short, short_metadata = core._truncate_stdout_text('ok')
print(json.dumps([
    {'status': 'success', 'output': output, **metadata},
    {'status': 'success', 'output': short, **short_metadata},
]))
