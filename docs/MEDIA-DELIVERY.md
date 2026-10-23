# Media delivery: registered gateway backend

Stack: port/media-backend into port/media-delivery (fork only). This continues the
original alt-glitch Hermes × Tern integration and Tern SDK from OMP/Stencil,
not a second router, runtime pin or core method override. The Hermes donor
implementation is at kvnloo/hermes-agent 724b2aaec5981eb264f65923f72858faff27bb5b,
ui-tsp/MEDIA-DELIVERY.md and tui_gateway/media_delivery.py. Its private
history-dictionary/transport helpers are not plugin authority.

## Source of truth

The exact-green gateway seam at kvnloo/hermes-agent
0ac4e9df39eecf3ce69a3ea3c80a6dc70dd7dcd5 exposes:

- PluginContext.register_gateway_method, strict Pydantic schema and the
  synchronous callback(request, params) in hermes_cli/plugins.py;
- GatewayRequestContext.assert_attached/capture_scope in
  hermes_cli/plugin_gateway_methods.py;
- GatewayScopeLease.assert_current, assert_caller, publish and close in
  hermes_cli/plugin_gateway_scopes.py. An upload request's capture is
  provisional until its originating RPC succeeds. The preview request uses
  assert_caller with the actual new registered request, never a fabricated
  context, nonce or copied actor identity;
- Canonical gateway/session_plugin_methods.py: the RPC session_id is the
  durable session key, tied to original subscription, profile, live session
  generation, transport and runtime epoch;
- Legacy tui_gateway/methods_session.py:377/432/477: session.create/resume
  exposes both live RPC session_id and distinct stored_session_id. The
  existing authenticated _current_session_steer_authority helper maps the
  current legacy worker/transport to its server-owned session_key. No
  caller-supplied durable ID or viewer field is used for this mapping.

No public plugin request contains an authoritative tool execution host or
completed tool-result provenance. A tool_call_id provided by a client is
therefore refused, even if the path exists on the gateway. This is **not** a
successful tool preview. Hermes must expose caller-bound host/source facts in
a future public seam before a tool-path transfer can be supported.

## Registered methods

The plugin optionally registers hermes-tern.media.image and
hermes-tern.media.attach_bytes. Registration imports the new backend lazily:
on older Hermes without register_gateway_method, the original CLI, prompt
upload and card behavior remains available.

- Canonical composer uploads prefer hermes-tern.media.attach_bytes only when
  the attached gateway.capabilities list explicitly advertises it. The method
  strictly decodes at most 20 MiB, sniffs PNG/JPEG/GIF/WebP and stages **once**
  with the existing tui_gateway.prompt_attachments.stage_image_bytes in the
  original canonical cache/images root. A plugin-owned record binds original
  caller lease, profile home, durable session, exact random path, byte hash
  and file identity. No duplicate upload, private core image list or image
  blob ID is persisted.
- Old canonical gateways and all legacy sessions keep their original
  image.attach_bytes path: the legacy method also queues the next prompt,
  behavior the plugin cannot safely replace. Its canonical sibling does not
  provide a per-session staging list by itself; plugin-owned staging avoids
  treating unscoped cache files as permission.
- A staged image remains previewable only to its original attached
  controller under the original successful lease. Detach, generation change,
  session replacement or plugin unload revokes pending scope. Another viewer
  or profile cannot claim it by replaying the path.
- A resumed/persisted image is authorized through the owning profile's
  public SessionDB.get_messages_as_conversation(..., include_ancestors=True):
  a genuine durable user row must pair the exact @image: or [Image attached at:]
  reference with an image_url part containing **identical image bytes**.
  A typed @image directive or copied path alone is never authority.
  This handles original core uploads and persisted images independently of
  live staging. Images without such evidence fail closed.
- The image read validates an exact owned staging parent, regular non-symlink
  and non-hardlinked file, bounded fd-relative read (16 MiB), raster magic,
  supplied MIME, original stage byte/inode where applicable and an after-read
  file/owner/authority check. It never reads a same-named gateway path for a
  remote compute source. No owner-loop waits, polling or background IO.

The frontend only probes capabilities on explicit preview load, then calls
hermes-tern.media.image. It never invokes an unregistered media.image RPC,
opens a nonexistent image or synthesizes an SDK blob. Returned bytes pass
existing canonical base64, MIME and size checks and the negotiated
Session.blob(bytes, mime) API.

## Host boundary and current limits

Real Tern 0.9.5 negotiates media/image/blobs, but its observed session.info
does not include terminal_backend. No frontend, gateway or compute host can
be inferred from cwd, localhost, pane environment or an absent field. The
existing renderer appropriately refuses preview buttons where host identity
is unknown; even a staged gateway-owned attachment still needs a separate
renderer-owned source-origin signal before its chip can safely be enabled.
Do not modify frontend/src/view/media.tsx or global App/frame/stores to
bypass that restriction from this backend slice.

Legacy PNG/GLB read_file binary refusals remain refusals; a PDF extracting
text remains a document extraction, not an image. Remote PDF/video/audio/3D
previews are unsupported. Native positively-known-local media, ordinary text
extraction and original prompt staging retain their existing behavior.

| Resource | Limit |
| --- | --- |
| Single plugin image preview | 16 MiB |
| Original/new composer upload | 20 MiB per image |
| Composer pending images / encoded retained payload | 8 images / 40 MiB |
| Preview loads | One at a time, explicit click/retry |
| Preview metadata | 32 entries, insertion-order eviction |
| SDK connection lifetime | 64 uploads / 64 MiB cumulatively across sessions |
| Optional plugin staging metadata | 256 path/lease records per process; oldest retired |

Never reset the SDK blob budget at session change or reuse a blob ID after
detach; Session.blob and Tern own encoding and wire caching.

## Verification to run on OMP's MBP

**Not executed in this GitHub-connector-only worker. Zero new pass counts
are claimed.** Use the exact hermes-agent PR650 0ac4e9df39eecf3ce69a3ea3c80a6dc70dd7dcd5
source in an isolated profile; never touch clean Hermes profile, defaults,
account settings or unowned Tern windows.

~~~sh
# repository root, on the exact port/media-backend head
export HERMES_PYTHON_SRC_ROOT=/absolute/path/to/hermes-agent-at-0ac4e9df
PYTHONPATH="$PWD:$HERMES_PYTHON_SRC_ROOT" python -m pytest -q tests/test_media_backend.py tests/test_plugin_registration.py
PYTHONPATH="$PWD:$HERMES_PYTHON_SRC_ROOT" python -m pytest -q tests

cd frontend
node scripts/hermes-src.mjs
bun install --frozen-lockfile --prefer-offline
bun run check
bun run test -- src/__tests__/media-delivery.test.ts src/__tests__/images.test.ts src/__tests__/read-media.test.ts
bun run bundle
~~~

On the isolated signed-in Tern 0.9.5 AgentDisplay window, confirm the
existing UNKNOWN backend notice for unproven tool and attachment paths;
verify original core uploads with and without optional plugin methods; run
approved canonical image attach/read against the same controller; then
detach, resume, switch profile and attempt another transport read. Verify
that only durable genuinely attached image bytes can resume, and that
PDF/video/audio/3D and binary producer refusals are unchanged. Each
outside-pane CLI mutation needs an explicitly verified owned --window key.

## Next slices (not implemented here)

1. **Hermes gateway public owner facts** (owned by a subsequent
   kvnloo/hermes-agent seam worker): expose attested local compute-host
   ownership and exact completed tool evidence through public
   GatewayRequestContext; do not read actor/history private fields.
2. **Overlay/renderer attachment origin** (owned by OVERLAYS/B renderer,
   frontend/src/view/media.tsx and the transcript projection it uses):
   distinguish a server-attested staged attachment from an unknown tool
   backend; do not trust client-supplied paths and preserve the UNKNOWN
   backend refusal for tool paths.
3. **Native isolated qualification** (OMP operator, not this worker):
   execute the commands above against the exact heads and genuine
   signed-in Tern with loopback-only model credentials, then record real
   counts and receipts after they exist.
