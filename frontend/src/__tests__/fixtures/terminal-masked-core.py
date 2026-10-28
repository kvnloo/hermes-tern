"""Produce pinned terminal advisories without running a command or writing a spill."""
import json
import os
import tempfile

with tempfile.TemporaryDirectory(prefix='hermes-terminal-masked-') as home:
    os.environ['HERMES_HOME'] = home
    from tools import terminal_tool_result as core

    core._sudo_annotations = lambda command, output, env_type: (output, False, False)
    core._apply_output_transform_hook = lambda command, output, returncode, task_id, env_type: output
    core._redact_spill_file = lambda path, total, command: []
    core._verification_evidence = lambda *args: None
    common = dict(env=None, env_type='docker', effective_task_id='t', task_id='t',
                  session_id='s', session_key='k', workdir=None, command_cwd=None, approval_note=None)
    def produce(command, output, recreated=False):
        result = {'output': output, 'returncode': 0, 'environment_recreated': recreated}
        return json.loads(core.finalize_foreground_result(command=command, result=result, **common))

    from gateway.run_turn_progress import _tool_complete_payload
    pipeline = produce('npm test 2>&1 | tail -20', 'npm ERR! test failed')
    event = _tool_complete_payload('c1', 'terminal', {'command': 'npm test | tail'},
                                   json.dumps(pipeline), is_error=False)
    print(json.dumps([
        pipeline,
        produce('npm test || echo failed', 'npm ERR! test failed'),
        produce('npm test 2>&1 | tail -20', 'npm ERR! test failed', True),
        produce('npm test 2>&1 | tail -20', 'all passed'),
        produce('grep ERROR app.log | head', 'npm ERR! historical log'),
        event
    ]))
