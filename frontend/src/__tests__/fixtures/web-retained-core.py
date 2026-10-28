"""Produce a pinned truncation footer without provider access or cache writes."""
import json

import tools.web_tools_truncate as truncate

truncate._store_full_text = lambda url, content: None
content = 'start\n' + 'x' * 16000 + '\nretained tail'
text, clipped = truncate._truncate_with_footer(content, 'https://fixture.invalid', 15000)
assert clipped
print(json.dumps({'results': [{'url': 'https://fixture.invalid', 'content': text}]}))
