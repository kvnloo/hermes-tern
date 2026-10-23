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
- Legacy tui_gateway/methods_session.py:377/432/477 exposes both live RPC
  session_id and a distinct stored_session_id to its own client. However the
  public registered GatewayRequestContext exposes only the live SID and profile,
  not an authenticated live-to-stored projection. This plugin does **not**
  inspect the server's private session table/transport helper or infer an owned
  durable key from user-supplied values; legacy preview remains unsupported.

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
- Actual core agent/session_persistence.py:_durable_content transforms inline
  image_url parts into a **text-only** stored representation. It does not
  preserve structured image bytes. Therefore a bare durable @image: reference
  or [Image attached at:] hint is not proof. The old fixture that appended
  structured image_url parts directly to SessionDB could not occur through
  production flush and has been replaced by a real write/flush/reload test.
- For a **canonical** resumed image, all three independent conditions are
  required: (1) a plugin-owned sidecar witness created **only after successful
  stage_image_bytes** with exact profile, durable session, path, SHA-256, size
  and inode; (2) an owning public SessionDB durable user row referencing this
  exact path; (3) an actual **terminal/completed** canonical
  session_admissions receipt (read with hermes_state_runtime.list_session_admissions)
  whose server-captured attachments_v1 contains the same committed SHA-256,
  byte length and MIME. A staged-only image, failed/queued admission, text
  marker alone, foreign session, altered file, un-attested same-byte copy
  or missing/invalid sidecar refuses preview. This is a conservative
  cryptographically fingerprinted byte witness, not a new input registry or
  override of canonical admission.
- Legacy original image.attach_bytes still stages and queues through core;
  namespaced attach_bytes refuses legacy to prevent duplicate enqueue. Since
  legacy has neither a plugin staging lease nor a public durable admission
  receipt plus live-SID mapping, **legacy resumed previews are unsupported**
  rather than pretending typed paths confer permission.
- The image read validates an exact configured profile staging parent
  (including the configured HOME symlink alias, never aliases below HOME),
  no-follow directory fd ancestry, regular non-symlink and non-hardlinked
  image and proof files, bounded fd-relative read (16 MiB), raster magic,
  supplied MIME, original stage byte/inode, and after-read
  file/root/owner/authority checks. It never reads a same-named gateway path for a
  remote compute source. No owner-loop waits, polling or background IO.

The frontend only probes capabilities on explicit preview load, then calls
hermes-tern.media.image. It never invokes an unregistered media.image RPC,
opens a nonexistent image or synthesizes an SDK blob. Returned bytes pass
existing canonical base64, MIME and size checks and the negotiated
Session.blob(bytes, mime) API.

## Host boundary and current limits

Real Tern 0.9.5 negotiates media/image/blobs, but session.info can omit
terminal_backend. That absence **does not** imply that a normal successful
gateway-staged composer attachment lives on the compute host. This slice's
attachmentImagePath and MediaDelivery now treat the independently established
active gateway attachment route as eligible for a **Load image preview**
control, even when terminal_backend is unknown. It performs no renderer IO,
assumes no local backend, and does not treat the client path as final proof:
the registered backend must positively attest bytes and ownership before
Session.blob is called. Unsupported/denied RPCs show retry errors, never
a made-up image or cached blob.

For **tool results**, remote compute locality and completed-tool provenance
remain unknown without a public server-authenticated contract. Unknown
terminal_backend still projects tool paths as unavailable. A client-provided
tool_call_id, a guessed path or a copied attachment scope cannot make the
server authorize those bytes. The renderer must not probe such paths locally.

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
approved canonical image attach/read against the same controller, and
genuinely submit + complete a canonical input carrying the image. Confirm
pending before submit, then detach, resume, switch profile, change backend
and attempt another transport read. Preview under UNKNOWN terminal_backend
must show an explicit Load for a gateway-owned staged image; no tool preview
must appear without independent server host/provenance evidence. Verify
that only a real stored user reference plus a settled core admission plus
the plugin's genuine stage witness survives resume. Exercise PNG and JPEG,
HOME symlink alias, malformed/failed uploads and no stale blob after reset.
PDF/video/audio/3D and binary producer refusals must remain unchanged. Each
outside-pane CLI mutation needs an explicitly verified owned --window key.

## Next slices (owned separately; not claimed complete)

1. **Legacy public proof seam — upstream core owner, NOT this PR**:
   kvnloo/hermes-agent `hermes_cli/plugin_gateway_methods.py`,
   `tui_gateway/plugin_methods.py`, `tui_gateway/methods_session.py`,
   `gateway/session_ingress_media.py` plus their production authority
   tests. A public authenticated live-to-durable SID identity and successful
   original queued-image attestation are prerequisite for legacy resumed
   preview. Do not expose private server session handles or copy grants.
2. **Tool host/provenance — upstream core owner, NOT this PR**:
   kvnloo/hermes-agent `hermes_cli/plugin_gateway_methods.py`,
   `gateway/session_plugin_methods.py`, `tui_gateway/plugin_methods.py`,
   and exact completed-tool/source tests. Expose public caller-bound compute
   host and finished-tool witnesses before adding tool image transfers.
3. **OMP qualification — fork-only Draft PR #24, these owned paths**:
   `media_backend.py`, `tests/test_media_backend.py`,
   `frontend/src/media-delivery.ts`, `frontend/src/view/media.tsx`,
   `frontend/src/__tests__/media-delivery.test.ts`,
   `frontend/src/__tests__/images.test.ts`,
   `frontend/src/__tests__/read-media.test.ts`, `docs/MEDIA-DELIVERY.md`.
   Run the frozen-offline commands above and the isolated native
   Tern 0.9.5 positive PNG/JPEG, reset, attach, profile, and host-proof
   regressions. No test/build/lint commands were executed in this
   GitHub-only implementation worker.
