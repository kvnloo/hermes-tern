# OpenUI prepared visual previews in hermes-tern

This downstream slice ports the Hermes `ui-tsp` /visual preview and result
discovery into the plugin's real session, transcript and Tern overlay stack.
It reuses the exact bundle validator and source fingerprints from the **Hermes
donor checkout**, rather than weakening its security contract. This plugin
does not include a generator, static OpenUI catalog, Luau renderer, approval
engine, browser harness or publishing pipeline.

## Local prerequisites

- Run `hermes tern` with `HERMES_PYTHON_SRC_ROOT` set by the source-checkout
  launcher to a checkout containing
  `ui-tsp/experiments/openui-preview/src/bundle.mjs` and its original
  `openui-generation/` and `tern/` files. Without them preview reads fail
  closed and the /visual help still works.
- Prepare an approved repository document and complete `.openui` program using
  that experiment's existing CLI. Disable OpenUI telemetry on every execution:
  `OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1`.
- Use a path on the **frontend host's own filesystem**; remote or container-only
  tool paths are not transferred.
- For the actual native treemap, separately enable the experiment's
  `hermes-openui` Tern file route. A file link otherwise follows Tern's normal
  file handling. This command does not install or enable anything.

## Session-local flow

1. `/visual` shows the exact JSON session/branch scope. Keep that value
   byte-for-byte for the CLI's scope positional argument.
2. Via the agent's terminal tool in the donor checkout, run:

   ```sh
   OPENUI_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 node ui-tsp/experiments/openui-preview/cli.mjs prepare \
     program.openui host-document.json '<scope-json>' /absolute/output --json
   ```
   A successful `--json` invocation must emit only the full JSON notice;
   path-only output is still supported for explicit `/visual /absolute/file.hvisual.json`.
3. Reopen `/visual` to list up to 12 recent completed terminal results.
   Up/Down + Enter or click selects; Escape cancels. Selection runs the
   donor's entire bundle validator, actual source fingerprints, current scope
   check and the reported ID equality check.
4. The native sheet shows host-projected Files/Text lines/File touches,
   initial mode, bundle ID and a file link. It never executes generated
   JavaScript or Lua. It never creates a model call or publishes an artifact.

Discovery reads at most 128 transcript entries, 512 blocks, 64 Ki of serialized
JSON text and 12 deduplicated candidates. A candidate notice is an untrusted
locator, not verification. A file read requires an absolute local path, a
bounded regular file, strict UTF-8 and JSON, then the real donor contract.
Observed session, branch or transcript replacement expires a sheet. Delayed
work never reopens a closed sheet or steals an approval's overlay.

The link opens the **current** file, not a captured immutable same-revision
handle. No real-window pixel approval or human publication receipt is claimed.
Resumed history may omit tool results. Host-authenticated native window E2E,
renderer packaging, first-paint timing and verified inline replies are separate
work.

## OMP gates

From `frontend/` after the usual pinned Hermes source setup:

```sh
bun run typecheck
bun run test src/__tests__/visuals.test.ts src/__tests__/visual-discovery.test.ts src/__tests__/visualOverlay.test.ts
bun run check
bun run bundle
```

The commands above are **not run by this connector-only port**. Exercise
`/visual`, successful `prepare --json`, discovery, swapped-file rejection,
session switches and Tern file-route behavior in an isolated Tern host before
promotion. Tern-serve and synthetic JSX do not establish ordinary native-window
or pixel parity.

## Source and provenance

Behavior is adapted from `kvnloo/hermes-agent`'s
`ui-tsp/src/visuals.ts`, `ui-tsp/src/visual-discovery.ts`,
`ui-tsp/src/overlays/visual.tsx`, `ui-tsp/src/overlays/visual-picker.tsx` and tests.
See source PRs [#456](https://github.com/kvnloo/hermes-agent/pull/456),
[#457](https://github.com/kvnloo/hermes-agent/pull/457),
[#460](https://github.com/kvnloo/hermes-agent/pull/460),
[#461](https://github.com/kvnloo/hermes-agent/pull/461),
[#464](https://github.com/kvnloo/hermes-agent/pull/464) and
[#466](https://github.com/kvnloo/hermes-agent/pull/466), plus
`ui-tsp/OPENUI-V2.md`. Preserve the original credit: Thesys/OpenUI for
generation, Can Bölük/Stencil Labs and Tern/OMP contributors for the protocol
and native view primitives, Hermes contributors for gateway/session ownership,
and bmdavis419/T3 Code for the preview/verify/publish lifecycle reference.
