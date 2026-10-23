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
- The existing image pipeline remains authoritative. Native image data URLs can be pasted or dropped, are decoded only after size and signature checks, uploaded through Hermes image.attach_bytes, and are abandoned if their chip is removed or the session changes. Ctrl+V, path pastes, /image and startup images retain their behavior.
- Alt+C copies the full draft; Alt+Shift+C copies the caret's line. Both preserve the draft and use the existing terminal clipboard channel, which has no delivery acknowledgement.

The media node is a small adapter for the Tern 0.1.0 SDK's generic node builder, as in the original ui-tsp implementation. Host media rendering still requires a real Tern host acceptance run.

## Validation for OMP

From frontend/:

    bun install --frozen-lockfile
    bun run typecheck
    bun run test src/__tests__/artifactLinks.test.ts src/__tests__/writtenArtifacts.test.ts src/__tests__/artifactAttachments.test.ts src/__tests__/artifactClipboard.test.ts src/__tests__/keys.test.ts src/__tests__/images.test.ts
    bun run check
    bun run bundle

Record typecheck, Vitest, full check, bundle and real Tern visual acceptance separately; none were run by this GitHub-only port worker.

Credit: Can Bölük and Stencil Labs for Tern, the TSP SDK and the original ui-tsp frontend patterns; alt-glitch for hermes-tern; NousResearch/Hermes contributors for the runtime and gateway.
