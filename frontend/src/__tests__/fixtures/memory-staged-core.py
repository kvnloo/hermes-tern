"""Exercise pinned staging and gateway serialization with fake gate/store, without writes."""
import json
from types import SimpleNamespace
from tools import memory_tool as mem, skill_provenance, write_approval as wa
from gateway.run_turn_progress import _tool_complete_payload

class Memory:
    def target_enabled(self, target):
        return True
    def add(self, *args):
        raise AssertionError('staged write reached store.add')
    def patch(self, *args):
        raise AssertionError('staged write reached store.patch')
    def resolve_entry(self, target, old_text, action):
        return {'success': True, 'matched_entry': 'old fact'}

wa.evaluate_gate = lambda *args, **kwargs: SimpleNamespace(allow=False, blocked=False, message='Pending approval')
wa.stage_write = lambda *args, **kwargs: {'id': '1a2b3c4d'}
wa.current_origin = lambda: 'foreground'
store = Memory()
args = {'action': 'add', 'target': 'memory', 'content': 'fact'}
skill_provenance.is_unattended_review = lambda: False
outcome, result = mem._memory_tool('add', 'memory', 'fact', None, None, None, store)
assert outcome == 'rejected'
first = _tool_complete_payload('single', 'memory', args, result)
args2 = {'action': 'patch', 'target': 'memory', 'old_text': 'old', 'content': 'new'}
skill_provenance.is_unattended_review = lambda: True
outcome, result = mem._memory_tool('patch', 'memory', 'new', 'old', None, None, store)
assert outcome == 'rejected'
second = _tool_complete_payload('proposal', 'memory', args2, result)
print(json.dumps([first, second]))
