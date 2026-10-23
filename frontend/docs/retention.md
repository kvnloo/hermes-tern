# Transcript retention and windowing

This downstream port adapts the tested Hermes `ui-tsp/RETENTION.md` and
`ui-tsp/src/retention.ts` design to the existing **hermes-tern** transcript
(`frontend/src/transcript/store.ts`) and entry projection
(`frontend/src/view/transcript.tsx`). It does not replace or truncate Hermes
session history, change its gateway RPCs, or create an independent session store.

## Boundaries

When Tern advertises the public SDK `settle` feature:

- Preserve the newest **20 completed assistant turns**. Keep running,
  interrupted, failed, warned, and unfinished tool/subagent/compaction entries
  (and their prompts) available. Never guess that an error was acknowledged.
- After the first presentation, diff **only changed entry roots**; release
  cached JSX and saved SDK trees for settled, cold entries. Streaming frames do
  not re-project old settled JSX, and `main` stays the same node.
- Keep the dock/layer and incremental history in **one Surface.send frame**,
  subject to the SDK's real ACK credits. Do not poll the terminal or invent
  viewport, scroll-end or history-request events.
- Interpret `gone.ids` only for this surface. Do not send operations against
  fully evicted historical roots. A cold entry does not resurrect on new tokens.
  Keep original entry IDs, including after a manual history reload.
- The **Load older history** action or **Ctrl+Home** explicitly restores up to
  **40** evicted entries, maintaining order. Keep the current reading page
  un-settled, then release it when another page is requested.
- Rebuild action routing only for the selected row. Queued handlers verify
  the entry still belongs to the current transcript before executing.
- Without `settle`, keep the existing `SurfaceHost.render` behavior.

Tern SDK 0.1.0 has `Surface.send`, `Surface.settle`, `View.ops`, `Tree`,
and `gone`, but **does not have** a viewport-range, lazy-scroll request, or
entry adoption API; automatic scroll-triggered history paging is not claimed.

## Qualification

Run on OMP's machine with a prepared Hermes source checkout:

```sh
cd frontend
bun run setup
bun run typecheck
bun run test src/__tests__/retention.test.ts
bun run check
```

Then run an **isolated** real Tern/Hermes pane with a throwaway
`HERMES_HOME`; verify:

1. Fresh and resumed sessions, including 200 and 2,000 history entries.
2. Running tools, waiting approvals, failed/interrupted turns and subagents.
3. Streaming deltas, compactions, late old-turn updates and Copy/rewind gestures.
4. Actual `gone` eviction (including a partial subtree) and manual
   Load older history / Ctrl+Home; untouched native scroll and composer cursor.
5. Credit=1, hidden→visible, resize, detach, quit, and no-settle fallback.

The Vitest suite is a **static implementation submission** in this PR: the
connector cannot run Bun, a real terminal, or native Tern e2e. Before promotion,
collect real frame-op/byte counts and p50/p95 timings; distinguish initial
history upload (necessarily O(history)) from steady streaming; benchmark
200 and 2,000 history entries with 5,000 deltas and identical ACK cadence.

## Sources and provenance

- Original Hermes donor:
  [RETENTION.md](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/RETENTION.md),
  [retention.ts](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/src/retention.ts),
  and [retention tests](https://github.com/kvnloo/hermes-agent/blob/preview/tern-frontend/ui-tsp/src/__tests__/retention.test.ts).
- Public [Tern SDK](https://github.com/stencil-hq/tern-sdk/tree/f3f9fee82bf692166c2a477a895a347ac2a47ca2/typescript/src)
  and [retention protocol](https://docs.stencil.so/tern/protocol/operations.md#retention).
- Existing plugin author [alt-glitch/hermes-tern](https://github.com/alt-glitch/hermes-tern).
  Tern/OMP public SDK primitives: Can Bölük / Stencil (MIT); Hermes source
  and integration: Hermes contributors; adapted for this plugin without
  copying the donor's entire application or changing runtime authority.
