"""Get unchanged stubs from pinned Hermes without a profile, files or a provider."""
import json
from tools.skills_tool_dedup import dedup_skill_view, reset_skill_view_dedup

reset_skill_view_dedup()
payload = {'success': True, 'name': 'example', 'content': 'retained skill', 'setup_needed': False, 'readiness_status': 'available'}
raw = json.dumps(payload)
results = []
for path in (None, 'references/guide.md'):
    first = dedup_skill_view('isolated-task', 'example', path, payload, raw)
    second = dedup_skill_view('isolated-task', 'example', path, payload, raw)
    assert first is None and second is not None
    results.append(json.loads(second))
reset_skill_view_dedup()
print(json.dumps(results))
