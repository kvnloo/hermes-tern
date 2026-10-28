"""Emit actual pinned terminal result serialization; do not run commands or write files."""
import json
import os
import tempfile

with tempfile.TemporaryDirectory(prefix='hermes-terminal-recreated-') as home:
    os.environ['HERMES_HOME'] = home
    from tools import terminal_tool_result as core

    core._sudo_annotations = lambda command, output, env_type: (output, False, False)
    core._apply_output_transform_hook = lambda command, output, returncode, task_id, env_type: output
    core._redact_spill_file = lambda path, total, command: []
    core._verification_evidence = lambda *args: None
    common = dict(command='true', env=None, env_type='docker', effective_task_id='t', task_id='t',
                  session_id='s', session_key='k', workdir=None, command_cwd=None, approval_note=None)
    flagged = json.loads(core.finalize_foreground_result(
        result={'output': 'shown', 'returncode': 0, 'environment_recreated': True}, **common))
    clean = json.loads(core.finalize_foreground_result(result={'output': 'shown', 'returncode': 0}, **common))
    failed = json.loads(core.finalize_foreground_result(
        result={'output': 'failure output', 'returncode': 2, 'environment_recreated': True}, **common))
    cancelled = json.loads(core.finalize_foreground_result(
        result={'output': 'partial\n[Command interrupted]', 'returncode': 130, 'environment_recreated': True}, **common))
    print(json.dumps([flagged, clean, failed, cancelled]))
