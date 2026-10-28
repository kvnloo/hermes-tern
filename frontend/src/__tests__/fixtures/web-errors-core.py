"""Exercise the pinned web extraction refusal paths without DNS or a provider."""
import asyncio
import os
import socket
import tempfile

home = tempfile.TemporaryDirectory(prefix='hermes-web-errors-')
os.environ['HERMES_HOME'] = home.name

import tools.url_safety as safety
import tools.web_tools as web

# No DNS or provider can run: a literal loopback resolves to a fixed synthetic socket result.
safety._getaddrinfo = lambda host, port=None: [(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('127.0.0.1', 0))]
def unexpected_provider(*args):
    raise AssertionError('provider must not run')
web._resolve_extract_provider = unexpected_provider
print(asyncio.run(web.web_extract_tool(['http://127.0.0.1/', 123])))
home.cleanup()
