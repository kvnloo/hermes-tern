"""Exercise pinned Hermes' pure already-applied patch decision and serialization."""
import json
import os
import tempfile

home = tempfile.TemporaryDirectory(prefix='hermes-patch-noop-')
os.environ['HERMES_HOME'] = home.name

from tools.file_operations import ShellFileOperations

ops = ShellFileOperations(None)
result = ops._no_match_result('file.py', 'new target text is already here', 'previous text', 'new target text', 0, None)
print(json.dumps(result.to_dict()))
home.cleanup()
