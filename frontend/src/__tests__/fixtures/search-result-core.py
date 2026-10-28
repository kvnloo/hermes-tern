"""Serialize real pinned Hermes search results for the frontend boundary test."""
import json
from tools.file_operations_common import SearchMatch, SearchResult

matches = [SearchMatch('src/a.py', i, f'  hit {i}') for i in range(1, 6)]
short = SearchResult(matches=matches[:4], total_count=4)
dense = SearchResult(matches=matches, total_count=7, truncated=True)
print(json.dumps([short.to_dict(densify=True), dense.to_dict(densify=True)], ensure_ascii=False))
