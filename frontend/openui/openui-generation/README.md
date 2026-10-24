# OpenUI generation adapter — isolated experiment

Related: [Hermes #432](https://github.com/kvnloo/hermes-agent/issues/432#issuecomment-6027153931),
[UX #436](https://github.com/kvnloo/hermes-agent/issues/436),
[OMP #143](https://github.com/kvnloo/oh-my-pi/issues/143),
[upstream OMP #14658](https://github.com/can1357/oh-my-pi/issues/14658).

This is the next **generation/compiler** slice, based on Hermes
`base/tern-frontend` at `9180555a3376b4b61bccab26269981a0c511c2e2`.
It does not reopen retired OMP #144, import itself at application startup, modify
the production frontend or root dependencies, or install a Tern plugin.

## What runs

```text
small library → OpenUI's generated prompt → existing host model call
  → complete OpenUI program → upstream parser + independent static checks
  → immutable native-view selection referencing an existing prepared artifact
```

Three application-defined components: `RepoExplorer`, `MetricRow`, `HottestFiles`.
They select existing view concepts; they are not OpenUI built-ins. The output is
**selection/composition only**. It carries an opaque host-prepared artifact ID
and renderer hash, not a second repository data format or invented metrics.
The historical snapshot shape is documented in OMP's
[`core.d.mts`](https://github.com/kvnloo/oh-my-pi/blob/experiment/native-visual-replies/experiments/native-visual-replies/core.d.mts).
No code from that retired branch is imported or merged.

The prompt is generated once per adapter. Supply eligible snapshot keys separately
in the host's task input, not by changing the catalog/system prompt on each update.
No model/provider call occurs in this package. The CLI is the concrete consumer
for testing the generation boundary before touching the running frontend.

## Run

From this directory, not the repository root:

```sh
export OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
npm ci --ignore-scripts --no-audit --no-fund --workspaces=false
npm test
node cli.mjs prompt
npm run demo
```

The local `.npmrc` disables lifecycle scripts as an additional install guard.
Only the isolated package depends on `@openuidev/lang-core@0.3.1` and its pinned
Zod peer. No React/chat app, Gateway, hosted repair, browser, Jev or TanStack is
installed. A missing package/API fails loudly; there is no replacement parser.

`fixtures/host.json` contains **synthetic handles**, not evidence of a rendered or
approved repository. Replace them with host-validated PreparedArtifact handles
when connecting a real consumer. Do not use an agent-provided registry as authority.

```ts
import { createGenerationAdapter } from './src/adapter.mjs';
const adapter = await createGenerationAdapter();
// Feed adapter.prompt to the existing host generation path once the catalog is selected.
// Only call compile after the host marks the model stream complete.
const selection = adapter.compile(completeProgram, {
  scope: hostSessionAndBranch,
  snapshots: hostApprovedHandles,
});
```

`selection.status` is always `validated-not-verified`. It is **not a receipt**,
permission, or publication request. Rendering/inspection/publication remains owned
by the host; a later integration branch must bind actual parser/adapter build,
renderer/template, data, theme/layout and interaction evidence before approval.

## Why the independent gate exists

OpenUI intentionally tolerates streaming: its lexer may skip characters, statement
splitter may drop invalid lines, and materializer may recover usable subtrees.
That is useful for partial previews but is not a strict complete-program validator.

This adapter uses public `tokenize`, `split` and `parseExpression` exports. It checks
**every statement**, including unreachable declarations, before `createParser`:

- Bounded lexical subset, JSON strings, bytes, nesting and statement count.
- Exact catalog calls/arity and only static literals, arrays and references.
- AST re-tokenization equivalence: dropped statements, ignored suffixes and parser
  repair cannot quietly turn a malformed final response into an accepted program.
- Duplicate IDs, unresolved references, cycles, orphans and explosive reference
  expansion fail before materialization.
- Independent named-prop/domain checks after parsing, plus no incomplete nodes,
  diagnostics, state declarations, queries or mutations.

This is a deliberately narrow **application input policy**, not a new OpenUI parser
or a guarantee about arbitrary OpenUI libraries. P0 excludes objects, comments,
fences, single quotes, operators, reactive state and action/tool calls. Generated
Luau/JavaScript, file paths, URLs and numeric repository measurements are not inputs.
No runtime evaluator or query manager is connected. No input sample contacts an
external target; rejection tests use inert strings and synthetic data only.

The identity covers exact source, catalog/limits, versioned generator contract,
host scope, prepared-artifact ID, renderer hash and view selection. Output is copied
and frozen; changing the host registry later cannot mutate an earlier handoff.
Never mistake this identity for proof of pixels or interactions.

## Tests and promotion

At implementation commit `ad418c46aaeff7262c5a3c3d0d4d948da0458ed0`,
[GitHub Actions run 37564802574](https://github.com/kvnloo/hermes-agent/actions/runs/37564802574)
passed **68 tests (39 host checks + 29 real-package integration checks), zero skips**,
and the CLI demo, on Node 22.16.0 / npm 10.9.2. The checked-in lock is copied from
that run's actual npm resolution, including package integrity hashes. CI now uses
`npm ci`; this is not a measured Tern or model-generation performance result.

`npm run test:host` exercises independent host validation/resource gates without
requiring npm dependencies. `npm test` additionally exercises the **real pinned
OpenUI parser/prompt API**; missing dependencies fail rather than skip. Keep these
results separate from model quality, Tern/Luau checks and end-to-end performance.

The branch-scoped CI runs the isolated install/tests/demo with read-only repository
permissions, disabled install scripts/telemetry, no inference and no secret-bearing
workflow context. It does not run or publish the product.

Next isolated slice: connect this selection to the current frontend's native
summary/expanded reviewed Luau view, and preserve the existing preview → inspect →
exact-revision publication owner. Progressive partial previews and upstream
`mergeStatements` edits are deferred to their own lane, not half-implemented here.
The current package has **no live UI wiring or measured rendering speedup**.

## Provenance

Credit **Kevin Rajan (@kvnloo)** for the OpenUI correction and native artifact
experiment; **Thesys/OpenUI contributors** for the language, parser and prompt
API; **Brit** for the explainer/ompish direction; **bmdavis419 and T3 Code
contributors** for the preview/verify/publish reference; and **Can Bölük / Stencil
Labs, OMP/Tern and Hermes contributors** for the native presentation and runtime
boundaries. This is not an upstream endorsement.

Source API inspection: OpenUI
[`7c8f5e9ae2e914063f7b47fc131fd46a7e178985`](https://github.com/thesysdev/openui/tree/7c8f5e9ae2e914063f7b47fc131fd46a7e178985/packages/lang-core).
The npm package is pinned separately; actual integration tests, not the source
version label, establish compatibility. OpenUI is MIT-licensed; preserve its
license/attribution when distributing it. No OpenDesign material is reused.
