"""Serialize count results with the actual pinned Hermes result class."""
import json
from tools.file_operations_common import SearchResult

results = [
    SearchResult(counts={'src/a.py': 2, 'src/b.py': 3}, total_count=8, truncated=True),
    SearchResult(total_count=0),
]
print(json.dumps([result.to_dict(densify=True) for result in results]))
