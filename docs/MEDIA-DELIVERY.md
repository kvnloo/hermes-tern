# Media delivery across Tern, frontend, gateway and compute hosts

This port follows [Hermes' reference MEDIA-DELIVERY.md](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/MEDIA-DELIVERY.md). The current frontend/src/media.ts is deliberately unchanged; upstream [#72](https://github.com/alt-glitch/hermes-tern/pull/72) owns URL/data-byte bounds and [#73](https://github.com/alt-glitch/hermes-tern/pull/73) owns URL invalidation.

## Native files and verified artifacts

Completed successful **read_file** calls with validated paths project images, PDFs, video, audio and 3D files to native Tern **media** nodes if the negotiated kinds include media. Older terminals receive a local **image** fallback for images; the ordinary read card remains for other formats. Unknown extensions and incompatible MIME types never qualify.

A successful **write_file** with verified = true, exact UTF-8 bytes_written, and no partial/truncated/error marker qualifies SVG and Mermaid as fenced Markdown, retaining the source, diff and diagnostics beneath. The fence expands around user content. Local model writes qualify for native media only if the host and Tern capabilities agree. The result's resolved_path takes precedence over the request path.

The pinned SDK's media node is sent using its public generic node builder with only key, path, and optional rev/link. No invented MIME, blob or tool-call-revision props.

## Image delivery across hosts

A tool-result media path is safe for Tern only with **positive** `terminal_backend === 'local'` proof, a live session, an unattached gateway, and none of SSH_CONNECTION, SSH_CLIENT and SSH_TTY. Absent, null, empty or whitespace backend identity is **unknown**: no native path, SSH frontend read or gateway/compute owner is inferred, even if an older `session.info` omits the field. Tool cards report the missing backend identity; attachments retain a non-clickable chip. A known-local attached gateway remains gateway-owned; a known-local SSH frontend remains frontend-owned. Separate compute backends never inherit frontend path authority.

A completed read/browser screenshot binds the gateway image path to its owning call ID. A resumed @image: reference preserves its original path identity even if it does not exist on the frontend. The user must click **Load image preview**: the frontend then calls the gateway's **media.image** with the active session and, for tool calls, the exact completed tool ID. Session-owned attachments omit the call ID; the backend must authorize the path against persisted/staged references. Unauthorized remote image-generation file paths remain inert.

SSH frontends with a local gateway read their own files using bounded no-follow regular-file I/O. Actual raster format is identified from bytes (PNG/JPEG/GIF/WebP), and declared MIME must match. Bytes are uploaded only with the SDK's negotiated Session.blob API. The resulting SDK blob ID, not a gateway file path, powers the native image node. Errors are visible with **Retry preview**; rendering never starts a transfer. Source removal, adoption, quitting and host changes invalidate stale operations and callbacks. Preview metadata is revoked on **every observed** session/cwd/backend/attachment/SSH authority change, including an A → B → A round trip; revision and Load/Retry action tokens change with the authority generation. Old SDK blob IDs are not reopened when the prior authority returns. Connection-wide upload budgets stay cumulative.

**Unresolved real-backend prerequisite (separate TRN2-HERMES-MEDIA-BACKEND):** The locked Hermes runtime has no authorized `media.image` RPC. A namespaced `hermes-tern.media.image` implementation through the approved generic plugin gateway-method seam must be present and capability-detected; the frontend host-identity guard alone does not enable remote image delivery. The Hermes companion fork implements media.image and transport/session authorization in [tui_gateway/methods_images.py](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/tui_gateway/methods_images.py) and [tui_gateway/media_delivery.py](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/tui_gateway/media_delivery.py). The standalone plugin cannot register a handler on another installed Hermes gateway. On a build without the method, an explicit load fails visibly; no unrelated local file is opened.

## Resource budgets

| Resource | Bound |
| --- | --- |
| Decoded preview | 16 MiB; bounded canonical base64 for remote responses |
| Frontend file | Regular file only, bounded stat/read; no-follow leaf when supported |
| Transfers | One in flight |
| Metadata | 32 cache entries, insertion-order eviction |
| SDK connection | Maximum 64 uploads and 64 MiB cumulatively |
| Adoption/quit | Clear state; never reset connection upload quotas |

Decoded buffers and base64 are not retained in the metadata cache. SDK 0.1 has no blob-release/re-upload API; terminal-side retention and eviction are owned by Tern, and exhausted connections require reconnection. Existing composer staging, URL media loading and its upstream bounds stay unchanged.

Nonlocal PDF/video/audio/3D previews are explicitly **unsupported** by the installed blob protocol. Their host-local native media behavior remains, and no remote compute filesystem is reinterpreted as the Tern host.

## Commands and manual qualification for OMP

Source and tests were committed through the GitHub connector. No tests were executed here. From the repository root, run:

~~~sh
cd frontend
node scripts/hermes-src.mjs
bun install --frozen-lockfile
bun run check
bun run test -- src/__tests__/media-delivery.test.ts src/__tests__/read-media.test.ts src/__tests__/images.test.ts src/__tests__/toolRegistry.test.ts src/__tests__/sessionReset.test.ts
bun run bundle
~~~

OMP must also smoke `HERMES_HOME="$(mktemp -d)" hermes tern` from its owned headless Sway session, with a real negotiated Tern peer and private media fixtures. A compatible, capability-advertising backend is required before testing authorized remote image loads.

Manual qualification on an installed Hermes build with media.image and a Tern peer: local PNG/PDF/MP4/GLB with native negotiation on/off; verified SVG/Mermaid source preservation; remote gateway attachment and browser screenshot explicit load/retry; SSH frontend/local-gateway preview; backend locality change; and an in-flight preview across session adoption or quit. No live terminal qualification is claimed in this PR.
