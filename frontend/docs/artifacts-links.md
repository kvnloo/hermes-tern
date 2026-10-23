# Hermes × Tern written artifacts, links and attachments

This port reuses the downstream Hermes ui-tsp contracts from
[WRITTEN-ARTIFACTS.md](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/WRITTEN-ARTIFACTS.md),
[links.ts](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/src/links.ts),
[read-media.ts](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/src/read-media.ts),
[attachments.ts](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/src/attachments.ts) and
[clipboard.ts](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/src/clipboard.ts).
It extends the existing hermes-tern frontend without replacing its tools, gateway or composer.

- A file URI is rendered only for a non-attached, host-local gateway with a session-provided working directory. File and line links never guess Tern's process cwd. Assistant Markdown local targets are resolved after the turn finishes. Remote and compute paths stay text.
- Only a completed verified write with exact UTF-8 byte count and compatible extension/MIME may become an inline SVG or Mermaid fence, or a local 3D media node with negotiated Tern media support. Existing source and diff remain visible; unverified writes remain ordinary cards. Generated code is never executed.
- The gateway remains authoritative for attachment paths. Native image bytes (validated MIME/signature, canonical base64, at most 20 MiB each) and real native `raw.path` paste/drop use separate typed intents. Native path reads require the same local Tern stream and non-attached gateway; SSH/remote-host paths are refused rather than fabricated as image bytes. Text pastes remain native editor input.
- The composer enforces **8 images and 40 MiB total**, charging landed and unsettled work, including canceled/removed uploads, with at most 8 in flight. Admission and exact-size reservations precede bounded local file reads, base64 decode, or upload. Original image bytes are not rewritten; accepted files keep their gateway path/mime identities. Budgets release on actual settlement/removal/take; a failure leaves no submitted ref.
- Every image stays bound to the exact `SessionState.ref` object and captured live/stored IDs/gateway mode. Taken/held/queued images are revalidated before submission; a stale image refuses the **whole** prompt with an explicit notice and restores its text plus any still-owned attachments rather than submitting without its image. A->B and reused-ID A->B->A cannot deliver late results, notices or old image refs to a different draft, submission or restore. Startup images bind to the actual first adopted session and may still join the queued startup query. Session/ref authority is local metadata, never serialized with a prompt.
- Pinned Tern 0.1.0 `decodeEvent` exposes native paste/drop as an `ev: 'unknown'` wrapper with the original frame in `raw`. Parsing unwraps it without widening TspEvent; bare base64 is bounded before building a data URL, and oversize native bytes show a warning.
- Prompt hydration removes only **terminal absolute-path** persisted `@image:` suffixes (optionally followed by matching `[screenshot]` placeholders), with a single canonical terminal LF/CRLF. Relative directives, prose and fenced examples remain literal.
- Alt+C copies the full draft; Alt+Shift+C copies the caret's line. Both preserve the draft and use the existing terminal clipboard channel, which has no delivery acknowledgement.

The media node is a small adapter for the Tern 0.1.0 SDK's generic node builder, as in the original ui-tsp implementation. Host media rendering still requires a real Tern host acceptance run.

## Validation for OMP

From frontend/:

    bun install --frozen-lockfile --prefer-offline
    bun run typecheck
    bun run test src/__tests__/artifactAttachments.test.ts src/__tests__/artifactClipboard.test.ts src/__tests__/artifactPromptRefs.test.ts src/__tests__/images.test.ts src/__tests__/keys.test.ts src/__tests__/dockModel.test.ts src/__tests__/artifactLinks.test.ts src/__tests__/writtenArtifacts.test.ts
    bun run check
    bun run bundle

Record typecheck, Vitest, full check, bundle and real Tern acceptance separately on the **final PR head**. The image tests now include real App deferred switch/drain and refused native oversized-byte notice. These are in-process SDK-shaped fixtures, **not** proof of native Tern host paste/drop behavior. Earlier MBP receipts at `9c1c801d4da4ed74f92a56bd0117556e79cdea09` qualify that older head only; GitHub-only work cannot run any of these commands.

## Remaining (separate TRN3 artifact ownership)

1. **Glob/grep result file links:** `frontend/src/view/tools/cards/search.tsx`, `frontend/src/view/tools/shell.tsx` and their dedicated renderer tests. This wave does not touch tool/card/view context.
2. **Read/edit/patch anchors:** `frontend/src/artifacts/card.tsx`, `frontend/src/artifacts/links.ts` and their dedicated contextual link tests, also owned by TRN3. No full artifact parity claim until both waves pass their own MBP and native gates.

Credit: Can Bölük and Stencil Labs for Tern, the TSP SDK and the original ui-tsp frontend patterns; alt-glitch for hermes-tern; NousResearch/Hermes contributors for the runtime and gateway.
