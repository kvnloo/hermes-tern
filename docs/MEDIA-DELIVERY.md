# Media delivery: exact canonical attachment resume

This is a fork-only correction to Draft PR #24, stacked on
`port/media-delivery`. The original alt-glitch Hermes × Tern
integration and Can Bölük / Stencil's `@stencil-hq/tern` SDK
remain the implementation base. No core patch, second admission, image queue,
runtime pin, upstream write or global registration change is made here.

## Verified source and actual canonical path

Use Hermes PR650's exact core
`0ac4e9df39eecf3ce69a3ea3c80a6dc70dd7dcd5`:

- `hermes_cli/plugin_gateway_methods.py`: public authenticated
  `GatewayRequestContext.session_id`, `profile`,
  `assert_attached()`, `capture_scope()`.
  `hermes_cli/plugin_gateway_scopes.py`:
  `GatewayScopeLease.assert_caller(current_request)`
  authenticates only a later live invocation by the same original caller.
- `gateway/session_plugin_methods.py`:
  canonical registered dispatch ties the request SID to the attached,
  authorized durable session and the live runtime generation. Legacy
  `tui_gateway/plugin_methods.py` has no public authenticated
  live-SID-to-durable-key mapping; legacy preview stays unsupported.
- `gateway/session_ingress_media.py`: public
  `prompt.submit` admission captures staged bytes as immutable
  `attachments_v1.media` references with an **exact**
  `{path, sha256, size}` in the profile-owned
  `cache/documents/native-inputs/<sha256>/<original-staging-filename>`
  (or the configured `document_cache` fallback). The
  original upload at `cache/images/tern_upload_*.png` is
  disposable. `restore_attachments` calls the real
  `restore_native_media` to revalidate the committed bytes.
- `agent/image_routing.py:build_native_content_parts`
  produces the real user text
  `[Image attached at: <COMMITTED_NATIVE_INPUT_PATH>]`
  and a live `image_url` part. The actual
  `agent/session_persistence.py:SessionPersistenceMixin`
  durable flush stores that **committed-path** marker plus
  `[screenshot]` as text; it does not store image bytes
  or an original staging `@image:` reference.

The former green test manually authored
`@image:<ORIGINAL_STAGING_PATH>` in the persisted user
message. Production canonical admission does **not** generate that path.
That false positive is replaced with an actual authenticated public
`prompt.submit` → `attachments_v1` →
`restore_native_media` → real content builder →
`SessionPersistenceMixin` flush → fresh read-only reload →
registered plugin read chain. A queued, failed, foreign or missing receipt
does not authorize even if text or image bytes happen to match.

## Plugin-owned proof and read gates

The existing optional gateway methods are unchanged:

- `hermes-tern.media.attach_bytes` (canonical only) stages
  PNG/JPEG/GIF/WebP with the original `stage_image_bytes`,
  retains the successful upload's original scoped lease, and writes the
  version-2 private `.tern-proof` witness only at staging time.
  Its exact original filename/path, profile, durable SID, SHA-256, size,
  MIME and original dev/inode are independently checked. There is no
  second image admission or queue.
- `hermes-tern.media.image` accepts an original staging
  path only while `lease.assert_caller(current_request)`
  remains valid. A real `claim_session_input`
  increments runtime generation and revokes that staging authority.
  Detach, re-attach under another subscription, plugin unload, and
  original staging cleanup never renew it.
- A resumed **canonical** read accepts **only** an exact retained
  `native-inputs/<sha256>/<original-filename>` path,
  with matching signed-in session/profile/home, version-2 stage witness,
  genuine persisted **user** marker for that committed path, and a real
  terminal/completed `session_admissions` receipt whose
  `attachments_v1.media` **path, digest and size** plus
  corresponding MIME match the requested bytes. A new file with the
  same content at an unproven path, a typed image hint, a malformed/queued/failed receipt,
  a different session, an unproven staging file, or a supplied
  `tool_call_id` never grants permission.
- The retained file is read through a **bounded (16 MiB),
  fd-relative O_NOFOLLOW walk** from the actual profile native-inputs
  root through the digest directory to a regular single-linked leaf.
  The same no-follow ancestry, file dev/inode/size/mtime, MIME/magic,
  SHA-256 and caller are validated after proof/DB reads. The witness
  itself is also a bounded single-linked no-follow file in the
  original staging root. If the original staging leaf still exists,
  its bytes and original inode must match; if it has been cleaned,
  the proven witness **and** real committed receipt remain necessary.
- Core may prune a terminal attachment's retained bytes; missing
  committed bytes always refuse (never reopen the original staging
  path or recreate media).

Retained previews are bounded by core's approximately 24-hour media
and witness cleanup, not permanent image storage. Committed files are
bound by their exact receipt path, digest and size; the receipt does not
retain an original committed inode. Identical-content replacement at
that same committed path is therefore not an inode-authenticity claim.
A non-vision turn that persists no image-attachment marker, or an image
no longer present in the active conversation rows after compaction,
is refused rather than granted from a typed hint or inferred lineage.

The plugin does not inspect private session tables, runtime actors,
transports or tool-call host identities. It never uses a client-supplied
`tool_call_id` as provenance. An unknown tool compute host,
PDF, GLB or other binary read is still unsupported; the original
binary refusals and PDF text extraction remain unchanged.

## Tern frontend and legacy sessions

Tern `session.info` can omit `terminal_backend`.
A confirmed **canonical** attached gateway's genuine stored prompt
attachment can still present the explicit Load preview action:
`frontend/src/view/media.tsx` routes only the
attachment path, then `frontend/src/media-delivery.ts`
discovers `gateway.capabilities` only on click, requests
the registered backend, verifies decoded bytes/MIME/size, and calls
Tern `Session.blob` within its quota. Local nonattached
previews and the old prompt composer thumbnail path are unchanged.

A legacy WS also sets `gw.attached` but is **not
canonical**. The frontend therefore requires actual
`gw.isCanonical === true` for this gateway attachment
preview; otherwise its text notice says exactly
**"Image preview unsupported for legacy sessions"**. It never renders
an always-failing Load/Retry control, calls capabilities or sends a
namespaced media RPC for legacy. The original legacy
`image.attach_bytes` stages **and queues once**, unchanged.
Capability-mode switches invalidate cached blobs; no previously
authorized canonical blob is reused after a legacy transition.

| Limit | Policy |
| --- | --- |
| Plugin image read | 16 MiB per regular file |
| Composer upload | 20 MiB |
| Pending composer images | 8 images / 40 MiB encoded payload |
| Preview metadata | 32 entries, bounded insertion-order eviction |
| Tern connection blob budget | 64 uploads / 64 MiB |
| Plugin pending scoped upload records | 256 records |

## Frozen exact-head qualification: OMP only

**No build, test, lint or native smoke was executed by this
GitHub-connector-only worker. Zero new passing tests claimed.**
Previous MBP receipts (frontend 978/978, targeted 132/132, actual
core Python 57/57, ratchets and bundle) are for earlier exact heads
and do not prove this correction. The known baseline GitHub Python
CI failure lacks the required `hermes_cli` setup; use
the pinned actual core checkout for these commands:

Frontend attachment regressions live in `mediaAttachments.test.ts`;
cross-host delivery remains in `media-delivery.test.ts`. Both reuse
`mediaDeliveryFixtures.ts`, keeping each suite below the unchanged
600-line ceiling without removing assertions.

The Python admission regression uses the actual dispatcher, attachment
capture/restore, content builder and persistence flush/reload, but drives
those stages in sequence with a test-authorized connection. It does not
exercise WebSocket login, a scheduled provider turn, or native signed-in
window acceptance. Those remain distinct qualification gates.

```sh
# From kvnloo/hermes-tern, on the NEW exact PR #24 head
export HERMES_PYTHON_SRC_ROOT=/absolute/path/to/hermes-agent-at-0ac4e9df
PYTHONPATH="$PWD:$HERMES_PYTHON_SRC_ROOT" python -m pytest -q tests/test_media_backend.py tests/test_plugin_registration.py
PYTHONPATH="$PWD:$HERMES_PYTHON_SRC_ROOT" python -m pytest -q tests

cd frontend
node scripts/hermes-src.mjs
bun install --frozen-lockfile --prefer-offline
bun run test -- src/__tests__/media-delivery.test.ts src/__tests__/mediaAttachments.test.ts src/__tests__/images.test.ts src/__tests__/read-media.test.ts
bun run check
bun run bundle
```

OMP must preserve the exact new head, repeat its full
frontend/targeted/Python/bundle ratchets, then use an owned isolated
canonical Tern connection and actual signed-in `prompt.submit`
for genuine PNG **and** JPEG: staging preview while the original lease
is valid; admission of the original stage; real native committed
reference; generation advance and original lease revocation;
production content build, flush and reload; staging deletion;
fresh authenticated resume; successful committed preview. Repeat
negative cases for same-byte copy, forged text, missing/queued/failed
or foreign receipt, replaced inode, symlink/hardlink/digest ancestry,
profile switch, detach and unknown tool host. Separately check the
legacy explicit unsupported notice without Load/Retry; retain
original legacy attach-and-queue behavior once.

## Ordered remaining slices (exact ownership)

1. **OMP exact-head proof and correction if needed** — this PR's
   `media_backend.py`, `tests/test_media_backend.py`,
   `frontend/src/media-delivery.ts`,
   `frontend/src/__tests__/media-delivery.test.ts`,
   `docs/MEDIA-DELIVERY.md`. Verify public
   production evidence and negative authorization fixtures.
2. **Owned signed-in native Tern acceptance** — new evidence in
   `docs/MEDIA-DELIVERY.md` with tests in
   `tests/test_media_backend.py` and
   `frontend/src/__tests__/media-delivery.test.ts`.
   Record PNG/JPEG, legacy, detach/reconnect, file cleanup and
   exact commands at the frozen head; keep PR Draft until verified.
3. **Out-of-scope optional tool provenance** — no implementation
   in this PR. Public authenticated compute-host / completed-tool
   evidence would require a separately approved core ownership
   decision before any future module in `media_backend.py`
   or tests are expanded. The current behavior remains explicit
   refusal; **no new core seam is requested or implied here**.
