# Tern browser blocks

This frontend presents the browser-block controls from the existing Hermes × Tern
`ui-tsp` integration. The backend remains the sole authority for page ownership,
browser selection, frame selection, and cleanup. The Tern Surface Protocol UI
describes only state and explicit user intents. No discovery result gives drive
permission.

## Use

Open **Tern browser blocks** with `Alt+Shift+B` or `/browser-blocks`.
The sheet lists the native block id, title, URL, and owner. Select a block
with Up/Down or click its row. Enter (or its action) means:

- **Hand over to agent** on an available, undriven block: request `browser.adopt`.
- **Focus** on an already owned block: request `browser.focus`.

For an owned block, **Release / close owned block** requests
`browser.release`: adopted pages remain open, agent-created pages close, and
the sheet reloads only after the server confirms release. A failed cleanup is
reported, not presented as success. **Evaluation frame…** requests
`browser.frame` with `main` or an exact native index path such as `0`
or `1.0`; Hermes must verify the frame. Child-frame snapshot, input,
navigation and capture are not available. Console buffering, recording and
annotated capture are not emulated.

Handover, release, and frame changes are blocked during an active turn;
focus on an owned block is allowed because the backend rechecks ownership.
Closing a sheet or switching sessions invalidates late UI replies; the
frontend neither polls nor maintains a local page-ownership registry.
The browser tool card shows a confirmed `tern_target` identity when a
stored or live tool result contains one, but never treats that metadata
as authority.

## Gateway compatibility

`frontend/hermes-src.lock` pins Hermes
`22063fc099ec9ad8357d7f8f6e6248a0400680d3`, whose generated
`apps/shared/src/gateway-contract.generated.ts` does **not** yet declare the
browser-block RPCs. The donor at `kvnloo/hermes-agent` branch
`preview/tern-frontend` declares:

`browser.blocks`, `browser.adopt`, `browser.focus`, `browser.release`,
and `browser.frame`.

`src/wire/browser.ts` validates replies at that versioned boundary.
Older gateways report an unsupported method, with no fallback that could
silently adopt another page or switch the user's browser backend.
The plugin alone does not install the backend adapter. Any runtime rollout
must use a gateway that implements and enforces the donor contracts.

## Checks for OMP

With `HERMES_SRC` pointing to a checkout of the pinned Hermes SHA:

```sh
cd frontend
HERMES_SRC=/path/to/hermes-agent bun run setup
bun run test -- src/__tests__/browserBlocks.test.ts src/__tests__/browserOverlay.test.ts src/__tests__/keys.test.ts
bun run check
```

These are validation commands, not a claim they have been run here.
Native acceptance needs an isolated, signed-in Tern window with its own config
and daemon, never a user's live panes: inspect, adopt, focus, release, frame,
gateway refusal, late listing and abandoned native opens. Fake gateway and
TSP-view tests are not native-browser certification.

## Provenance

Adapted from `kvnloo/hermes-agent/ui-tsp/BROWSER.md`,
`ui-tsp/src/browser-blocks.ts`,
`ui-tsp/src/overlays/browser-blocks.tsx`,
`ui-tsp/src/view/browser-blocks.tsx`, and browser tests on
`preview/tern-frontend`. Original Hermes authors: NousResearch.
Tern, TSP and OMP work: Can Bölük / Stencil; the frontend's package uses
`@stencil-hq/tern` 0.1.0. The donor's native page operations follow
https://docs.stencil.so/tern/print.html#browser-blocks and
https://github.com/can1357/oh-my-pi/blob/eb74cf84d8e16ac9b8c4fa5d7c43037023d016ac/packages/coding-agent/src/tools/browser/tern/tern-tab.ts.
