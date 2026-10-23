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

- **Hand over to agent** on an available, undriven block: request `hermes-tern.browser.adopt`.
- **Focus** on an already owned block: request `hermes-tern.browser.focus`.

For an owned block, **Release / close owned block** requests
`hermes-tern.browser.release`: adopted pages remain open, agent-created pages close, and
the sheet reloads only after the server confirms release. A failed cleanup is
reported, not presented as success. **Evaluation frame…** requests
`hermes-tern.browser.frame` with `main` or an exact native index path such as `0`
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

## Gateway compatibility and authority

The generic seam is green on the Hermes downstream
`kvnloo/hermes-agent#650` head
`ba42d324b3300639b826fd7cdb20173935561389`.
This plugin registers its own five `hermes-tern.browser.*` methods
through `PluginContext.register_gateway_method`. No core Python methods,
runtime pin or JSON-RPC router are altered. `gateway.capabilities`
must advertise those exact registrations for a live `session_id`;
an older gateway explicitly refuses them. This frontend retains its frozen
Hermes source pin for builds, while native acceptance needs the *separate*
green gateway checkout.

The frontend obtains canonical identity from the attached session's
server-supplied `session.info.profile_name` and its original `session.ref`.
It issues the existing profile-qualified *core* request
`config.get({key:'profile',session_id,profile})` (KEY head b93ca91).
It then queries `gateway.capabilities({session_id})` and calls
`hermes-tern.browser.*({session_id,...})` without a `profile` field:
the green seam rejects such a client-selected field. Missing or changed
profile identity refuses rather than guessing `default` or falling back
to a session-id-only pin.

The gateway validates the live original peer, transport, session generation,
and owning profile. Its `GatewayRequestContext.capture_scope()` is an
opaque caller-bound lease: a Tern viewer marker from the MODULE helper
`tern_env.pane_env(session_id)` supplies live pane variables, not authority.
The plugin freezes the first viewer, window and original task; replacing a
viewer cannot redirect old claimed pages.

Drive requires **explicit operator consent** via the per-profile
`plugins.entries.hermes-tern.allow_tool_override: true` or
`tools.override` capability. This plugin never grants consent or mutates
a user profile. Without it, discovery may list pages but cannot drive.
With it, browser tools are overridden only through the public
`ctx.register_tool(...,override=True)` so Hermes scope, pre-tool hook and
guardrail checks precede native effects. A `tool_execution` middleware
runs before those checks and is forbidden for native browser dispatch.
Revoking consent disables effects. Explicit CDP wins initially; once
native ownership is claimed, a failed effect never switches to CDP or
another page/backend.

**Known canonical prerequisite:** the green registered-method request
context exposes profile, session and captured lease, but does not expose
a documented task/busy-turn snapshot. The legacy TUI backend uses the
existing `_current_session_steer_authority` to obtain task identity and
the running fence. Canonical sessions lacking an equivalent trusted
task/busy accessor can discover read-only, but adoption/focus/release/frame
remain explicitly unsupported; the backend must not infer this from
frontend state. The subsequent gateway API projection belongs in
`kvnloo/hermes-agent`, not in this fork's runtime pin.

Undriven blocks require explicit handover. Foreign driven blocks cannot
be adopted. Adopted pages release without closing; created pages close
on release. Failed cleanup retains its claim. Indeterminate opens
quarantine their original window; only the exact late open response ID
can identify a page for cleanup. Titles, URLs or list differences
never establish ownership. Child frames are verified exact paths and
support evaluation only, not trusted child input/snapshot/nav/capture.

## Checks for OMP

With `HERMES_SRC` pointing to a checkout of the pinned Hermes SHA:

```sh
cd frontend
HERMES_SRC=/path/to/pinned-hermes-agent bun run setup
bun run test -- src/__tests__/browserBlocks.test.ts src/__tests__/browserOverlay.test.ts src/__tests__/keys.test.ts
bun run check
bun run build
```

Test the Python plugin against the separate green Hermes source checkout:

```sh
PYTHONPATH=/path/to/green-hermes-agent python -m pytest -q tests/test_browser_native.py tests/test_browser_backend.py tests/test_browser_gateway_dispatch.py tests/test_plugin_registration.py
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
