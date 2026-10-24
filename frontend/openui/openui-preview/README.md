# OpenUI → native preview bridge (opt-in experiment)

Stacked on [Hermes #456](https://github.com/kvnloo/hermes-agent/pull/456), generation
head `2d6240fc4426a245e0fef3e5b4ab05abddc5d39d`. This directory is the next isolated
slice for [#432](https://github.com/kvnloo/hermes-agent/issues/432) and
[OMP #143](https://github.com/kvnloo/oh-my-pi/issues/143). Do not merge a retired
OMP experiment or change the production composer/gateway to try it.

## What this adds

```text
host-prepared repository document + #456's complete OpenUI program
  → real OpenUI parser selects mode, metric keys and hottest-file limit
  → immutable bundle bound to data, selection, scope, renderer and adapter bytes
  → explicitly opened Tern Luau pane
  → identity-checked keyboard/pointer recipe + actual PNG files + control replies
  → human pixel inspection, separately from capture
  → host-only guard returns the exact approved revision for local publication
```

The supplied CLI prepares and captures. It **does not publish**, call a model,
install/link a plugin, launch a browser, close a window, or modify a Hermes session.
The `PreviewSession` API is an opt-in host coordinator, not a new approval owner:
its `publication()` returns `approved-for-local-publication` data. Integrating that
handoff into the production frontend's transcript/session store remains separate.

The fixed Luau viewer is an adapted code-review candidate, not model-generated
code and not a claim of completed human review. It renders a bounded treemap,
selected KPIs, and hottest **descendant files by churn** (not directory bars).
Code/Churn, selection, pointer/keyboard drill and Back are local state transitions.
Views are cached; directory/mode projections are reused; unchanged input returns
false. Nothing in view/hover/navigation starts inference, a process or networking.

## Prepare and open a preview

Install only #456's existing isolated dependencies, with its lockfile and opt-outs:

```sh
cd ui-tsp/experiments/openui-generation
export OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
npm ci --ignore-scripts --no-audit --no-fund --workspaces=false
cd ../openui-preview
OUT="$(mktemp -d)"
node cli.mjs prepare ../openui-generation/fixtures/explorer.openui \
  fixtures/repository.json local-dogfood:branch-a "$OUT/bundles"
```

The last line prints an absolute `.hvisual.json` file path. The fixture contains
**synthetic metrics**. Replace it only with an explicitly supplied host document;
the model never gets file-path or repository-measurement authority. The CLI makes
that document available to the generation catalog under the key `demo`.

Review the fixed files under `tern/`, then explicitly link the plugin using
`tern plugin link /absolute/path/to/openui-preview/tern` on a disposable local
Tern installation. Use an **ordinary live window**, e.g.
`tern --control /tmp/hermes-openui-test.sock`. In its terminal pane, run
`tern open /absolute/path/printed-above.hvisual.json`. The narrow file route opens
a separate native artifact pane; it is not a live inline child of the Hermes chat.

Neither linking nor opening is automatic. Keep the plugin installed on the same
local host as the snapshot; remote/multi-host operation is not validated here.
Snapshots and captures must stay outside the watched source/plugin directories,
including symlink aliases. Read-only content-addressed files are not a security
boundary against other programs running as the same local user.

## Capture without pretending a screenshot request is a pixel pass

One operator must exclusively own the test control endpoint during the recipe.
It resizes/rethemes that test window and sends input to the preview. It does not
restore the window's previous geometry/theme. Never target a working session.

Determine the window's actual shot output directory from a `tern ctl ... shot`
reply for your build; pass that directory as `SHOT_ROOT`. The runner uses unique
shot names and inspects only a bounded subtree beneath that explicitly supplied
local directory. It does not guess a sandbox/download path from a tool response.

```sh
node cli.mjs capture /absolute/preview.hvisual.json \
  /tmp/hermes-openui-test.sock /absolute/tern-shot-output-dir --allow-control-input
```

Before **every input and screenshot**, the recipe waits for the complete bundle
identity in the focused pane. It checks initial, Churn, pointer-drilled and restored
states; Enter/Back also exercise keyboard navigation. It requests four screenshots,
then requires matching files with PNG headers, reasonable dimensions and hashes.
This is header/dimension validation, **not a replacement image decoder or human
pixel inspection**. The same renderer/bundle sources are checked before and after.

Commands have a 25-second deadline, an overall 120-second capture budget and 2 MiB
reply limit. Failure, warnings, skips, missing PNGs and changed inputs fail closed.
A flat fixture cannot satisfy the drill/back check. Failure evidence is written
with `capture-failed`; success remains **`captured-not-inspected`**. Raw replies,
checks and local PNG hashes are saved privately; nothing is uploaded or shared.
The driver intentionally does not report control round-trip time as paint latency.

`tern shot` and `tern serve` without the real plugin runtime are not substitutes.
The mock transport tests exercise the recipe, not Tern itself. Even a successful
local capture does not attest an arbitrary installed plugin build or remote host;
verify the linked directory/build and inspect the actual images before promotion.

## Host lifecycle contract

`stage()` stores copied/frozen data. A same-revision retry preserves inspection;
replacement, cancellation, recapture and session/branch switches invalidate it.
Late captures cannot release a newer capture's lease. `inspect()` accepts only the
actual capture object minted in that session and explicit human acceptance.
`publication()` accepts only its current inspection object and rechecks the actual
source fingerprints after asynchronous work. Imported JSON receipts, booleans or
agent self-reports cannot replace those objects. The last good local handoff remains
available after a replacement fails; a scope change clears it.

This boundary trusts the host calling it and its capture driver. It is **not** a
sandbox against hostile host extensions or a human-identity authentication service.
The caller must stage authoritative data changes, invalidate views on layout/theme
or pane-lifetime changes, verify saved PNG hashes when presenting them for review,
and retain Hermes' normal session/approval authority for any consequential action.
No generated action invokes this coordinator. Restart requires a fresh capture and
inspection; the viewer persists neither approval nor transient navigation state.

The document retains the earlier `version/title/root` repository-tree shape, with
IDs, labels, code/churn counts and children. Directories must have accurate sums;
all numbers are bounded integers. Leaves represent files; omit empty directories,
which that format cannot distinguish from files. An empty root has zero files.
Model output controls only the existing view's composition. A new dataset/schema
or renderer is a separately reviewed change.

## Verification and remaining gates

```sh
npm test                                     # no npm dependencies needed
node --test test/integration.mjs              # requires #456's real core install
lua5.4 test/renderer.lua tern/host.luau         # stub Tern API, NOT Luau/Tern
```

Local implementation checks: **60 Node host/transport/lifecycle tests** and
**12 Lua 5.4 renderer-logic checks**, all passing. The local Lua checks used the
installed `liblua5.4` through a thin runner because no Lua executable is present.
No third-party Lua semantics substitute is used, but it is still not Luau or Tern.
The warm-mode check asserts zero additional sorts/reads, not measured UI speed.

The isolated CI workflow reruns #456's real-package tests and two integration
checks, the bridge tests, Lua mock checks, and the prepare CLI. It keeps installation
scripts and telemetry disabled and does not touch root dependencies.

**Not established:** actual Tern plugin load/`el`/chart rendering or control-reply
compatibility, live screenshots, installed-build attestation, model-generation
quality, production transcript mounting or composer/focus behavior, responsive
mobile/web parity, theme fidelity, reduced motion, or input-to-paint performance.
Keep this draft until the actual window tests and human inspection run.

## Sources and credit

- OpenUI generation/compiler boundary: Hermes #456, by Kevin Rajan (@kvnloo),
  building on Thesys/OpenUI contributors' language/core APIs; no OpenDesign code.
- Native treemap/load/navigation/CSS concepts adapted from the closed OMP
  `experiment/native-visual-replies` study, file
  `experiments/native-visual-replies/tern/host.luau`, blob
  `5d76c00594fc920e13c258440bb06299f971a1a2`; original CSS blob
  `fd41200af938460f5fc64c8838bc6c32b0231a2c`. This copies a bounded view concept,
  not OMP's runtime, an entire branch, or its generation harness.
- Credit Brit for the explainer/ompish direction; bmdavis419 and T3 Code
  contributors for preview → verify → publish; Can Bölük / Stencil Labs and
  OMP/Tern/Hermes contributors for the native UI and runtime boundaries.
- Tern primary contracts: https://docs.stencil.so/tern/guides/blocks.html,
  https://docs.stencil.so/tern/guides/routing.html,
  https://docs.stencil.so/tern/scripts/control.html,
  https://docs.stencil.so/tern/scripts/harness.html.

Preserve upstream licenses/attribution on redistributed code. References do not
imply endorsement. Jev, TanStack and the existing generation branch are unchanged.
