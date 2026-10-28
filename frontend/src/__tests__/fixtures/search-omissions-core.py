"""Exercise the pinned filter/serializer; use an isolated deterministic deny policy."""
import json
import os
import tempfile

home = tempfile.TemporaryDirectory(prefix='hermes-search-omissions-')
os.environ['HERMES_HOME'] = home.name

import tools.file_tools as ft
from tools.file_operations_common import SearchMatch, SearchResult

ft._resolved_match_path = lambda path, task_id: path
ft.get_read_block_error = lambda path: 'denied' if path == 'withheld' else None

def emit(result):
    omitted = ft._filter_read_blocked_search_results(result)
    payload = result.to_dict(densify=True)
    if omitted:
        # The wrapper in file_tools.search_tool appends this exact field after filtering.
        payload['_omitted'] = (f'{omitted} result(s) omitted because they target credential, '
                               'token, cache, or secret-bearing environment files.')
    return payload

results = [
    SearchResult(matches=[SearchMatch('safe', i, f'hit {i}') for i in range(5)] + [SearchMatch('withheld', 1, 'secret')], total_count=6, truncated=True),
    SearchResult(matches=[SearchMatch('safe', 1, 'hit'), SearchMatch('withheld', 1, 'secret')], total_count=2),
    SearchResult(files=['safe', 'withheld'], total_count=2),
    SearchResult(files=['withheld'], total_count=1),
]
print(json.dumps([emit(result) for result in results]))
home.cleanup()
