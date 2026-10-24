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
`0ac4e9df39eecf3ce69a3ea3c80a6dc70dd7dcd5`.
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
and owning profile. Its `GatewayRequestContext.capture_scope()` produces an
opaque original-caller lease; every later RPC must pass the public
`lease.assert_caller(current_request)` check while the RPC is live. The lease is
**not control-admitted until the originating RPC returns successfully**.
Initial block discovery is read-only: it may record the lease, but cannot
invoke control during its provisional start RPC. A second same-session peer
never receives the original viewer's grant. On older runtimes without the
public `assert_caller` API, native control is explicitly unsupported.
`tern_env.pane_env(durable_viewer_session_id)` supplies live pane coordinates, not authority.
The plugin freezes the original viewer, window and task; replacing the
viewer cannot redirect old claimed pages.

**Three identity domains are never interchangeable.** The request's live
`session_id` is an ephemeral RPC slot and binds the original caller/lease;
the actual legacy owner's `session_key` is the durable conversation ID
which names the frontend viewer marker and the exact prompt `task_id`;
the built owner's `agent.session_id` is the distinct tool-call
`session_id` forwarded by `tool_executor`. The plugin resolves these through
the trusted `_current_session_steer_authority` owner and its real agent,
never through client params or pane state. Discovery may be read-only
while that agent is building. The original lease is indexed only by its
live RPC SID, while tool dispatch requires both the unique original task
and exact agent SID to reach that **same driver**. A wrong tool SID,
duplicate task claim, resumed/replaced viewer, or generation change
fails closed; no second driver or browser fallback gains ownership.

Drive requires **explicit operator consent** via the per-profile
`plugins.entries.hermes-tern.allow_tool_override: true` or
`tools.override` capability. This plugin never grants consent or mutates
a user profile. Without it, discovery may list pages but cannot drive.
With it, browser tools are overridden only through the public
`ctx.register_tool(...,override=True)` so Hermes scope, pre-tool hook and
guardrail checks precede native effects. A `tool_execution` middleware
runs before those checks and is forbidden for native browser dispatch.
After a successful native commissioning, an uncached local `check_fn`
reports the actually selected consented native browser as available to
model-tool schemas even when unrelated agent-browser, Chromium/cloud or
extension backends are missing. It reads only local driver, consent and
registry state: **no Tern I/O, installer, network call or new lease** is
attempted during schema construction. Outside native support, the
preexisting browser availability predicates still decide. Tool handlers
continue through normal Hermes scope, hooks and guardrails.
Revoking consent disables effects. Granting it **after** the plugin loaded
without override handlers requires a plugin reload before native drive becomes
available; discovery remains read-only until the actual native tool handlers
are registered. No native claim is created with the original browser handlers
still selected. Explicit CDP wins initially; once native ownership is claimed,
a failed effect never switches to CDP or another page/backend.
Each model-tool CLI operation checks the original commissioned lease/profile/viewer,
live operator consent, actual selected native registry handlers and explicit CDP.
An open already dispatched cannot be cancelled, but a revocation or handler/CDP
change before its next snapshot/goto refuses that next CLI effect. Native
navigation and standalone snapshots use Hermes' forced secret redaction BEFORE
its bounded linewise truncation and optional redacted spill, not raw page text.
Unload is also fenced and runs **before** the original selected native handlers
are deregistered. When live consent, original registry selection, CDP preference,
and the original scope are all valid for each effect, agent-created pages close
and adopted pages release. Cleanup that fails, is not acknowledged, or cannot
be authorized leaves exact known claims, pending exact-ID open replies, and
unknown-open claims in **permanent quarantine** upon unloading the registration.
Regrant, reload, a new RPC slot, or a different viewer cannot recover the old
revoked scope or acquire that task/page. Listing reports
`available=false, reason=permanently_quarantined` without Tern I/O; drive is
unsupported. No later original-caller cleanup is promised: that original
registration is disposed. No forced close, guessed target, replacement lease,
or fallback browser is permitted. A refused scope, consent, handler or
CDP check before a late-open reply is not a CLI failure: it cannot consume
the pending process, clear its status or trigger cleanup. On unload that
original claim stays quarantined without any additional native I/O.
Native model schema availability also needs
the exact current task-local durable key and agent tool SID, never another
session's profile-wide browser claim; non-native checks retain their original
Hermes guardrails.


**Known canonical prerequisite:** the green registered-method request
context exposes profile, session and captured lease, but does not expose
a documented task/busy-turn snapshot. The legacy TUI backend uses the
existing `_current_session_steer_authority` to obtain task identity and
the running fence. Canonical sessions lacking an equivalent trusted
task/busy accessor are explicitly unsupported for
adoption/focus/release/frame. Without a trusted durable viewer ID, even
listing refuses rather than confusing the live RPC SID with a durable
marker. The backend must not infer these from frontend state. The subsequent gateway API projection belongs in
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
HERMES_SRC=/path/to/pinned-hermes-agent bun install --frozen-lockfile --prefer-offline
HERMES_SRC=/path/to/pinned-hermes-agent bun run setup
bun run check
bun run test -- src/__tests__/browserBlocks.test.ts src/__tests__/browserOverlay.test.ts src/__tests__/keys.test.ts
bun run bundle
```

Test the Python plugin against the separate green Hermes source checkout:

```sh
PYTHONPATH=/path/to/core-0ac4e9df39eecf3ce69a3ea3c80a6dc70dd7dcd5 python -m pytest -q -ra tests
PYTHONPATH=/path/to/core-0ac4e9df39eecf3ce69a3ea3c80a6dc70dd7dcd5 python -m pytest -q -ra tests/test_browser_gateway_dispatch.py tests/test_browser_backend.py tests/test_browser_native.py tests/test_plugin_registration.py
```

Run OMP's three independent review-only regressions for the distinct
live/durable/tool SID boundaries and native-only availability, against
that same core. Keep separate isolated source/profile environments.
These are validation commands, not a claim they have been run here.
Native acceptance needs an isolated, signed-in Tern window with its own config
and daemon, never a user's live panes: inspect, adopt, focus, release, frame,
gateway refusal, late listing and abandoned native opens. Verify a
fresh **owned Tern 0.9.5** window and an isolated loopback test page/model.
Every outside-pane Tern CLI mutation must pass that verified owned
`--window` key explicitly. Never default to a user's active Tern window.
Fake gateway and
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
