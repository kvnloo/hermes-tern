# Capture gate corrections

Isolated follow-up to [#457](https://github.com/kvnloo/hermes-agent/pull/457),
based on `1fb36535a2f703ec5675e2477ce6ad299088a170`.
This is a sibling of the [#460 repository collector](https://github.com/kvnloo/hermes-agent/pull/460),
not a dependency on that collector and not a new renderer or capture framework.

## Reproduced gaps and changes

- Exactly 128 children are all visible. The fixed viewer reserves the last cell
  for Other only above that limit. The recipe previously ignored the 128th cell
  unconditionally, rejecting a valid visible directory as missing drill coverage.
- CLI replies were checked more strictly than injected host-control replies.
  Both now reject error/skip/warning variants and oversized replies consistently.
  Bounded failing replies remain in failure evidence; stored replies are snapshots,
  not references that a transport can mutate later or that capture can freeze.
- Identity was checked before requesting a screenshot but not after its file read.
  A replacement during the final screenshot could therefore report capture success.
  Check identity again after each read and after final metadata collection.
- Recheck cancellation after awaited transport/file work. Late PNGs do not enter
  the successful-shot list, and a late final reply cannot return a capture pass.

The new checks add five identity round trips to a successful recipe. They run only
in the opt-in capture driver, never in the viewer or interaction path. They do not
provide atomic screenshot/build attestation: an ABA change or dishonest host is
outside this boundary, and human inspection remains necessary.

## Evidence and use

Seventeen targeted transport/recipe tests: **15 failed against the original
control source, all 17 pass after the fix**. Together with the unchanged 24 control
checks, **41 local Node tests pass** on Node 22.16.0, zero skips. Baseline source and
helper copies were checked against their Git blob hashes. These are synthetic
transport tests, not real Tern or image-decoding results.

Run `npm test` here for the full preview suite. The existing scoped workflow also
runs on `exp/tern-openui-capture-guards`; no workflow was duplicated and no package,
renderer, production UI or dependency lock changed.

**Re-prepare preview bundles after applying this slice.** The existing build
fingerprint includes `control.mjs`, so old bundles correctly fail the current-build
check. Reuse the approved repository document and complete OpenUI program; neither
recollection nor a new model call is required. Then follow the unchanged
[ordinary-window capture runbook](README.md#capture-without-pretending-a-screenshot-request-is-a-pixel-pass).
Use a disposable, exclusively owned window with explicit input consent. Success
is still `captured-not-inspected`; the CLI cannot publish or grant tool authority.

Real plugin loading, four rendered images, pointer/keyboard behavior, composer
focus, human inspection and input-to-paint remain live-host gates. Tern is not
installed in the local execution environment; no such results are claimed here.
Its official [debugging guide](https://docs.stencil.so/tern/guides/debugging.html)
and [script contract](https://docs.stencil.so/tern/scripts/index.html) distinguish
ordinary `--control` windows from headless fixtures that do not load user plugins.

Credit Kevin Rajan for the isolated native-artifact experiment; Can Bölük / Stencil
Labs and OMP/Tern contributors for the script/renderer contracts; Thesys/OpenUI,
Brit, bmdavis419/T3 Code and Hermes contributors for the underlying generation,
presentation and verified-lifecycle work. Existing provenance remains in README.
