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
- After the first presentation, use `Transcript.changedEntries` to inspect
  only changed/hot roots on token frames. The reducer marks revisions, including
  late tool-result edits; compaction lifecycle updates mark affected historical
  compaction views only when compactions change. Full scans are for membership,
  completion/settlement boundary and presentation-context changes, not tokens.
  Release cached JSX and saved SDK trees for settled, cold entries. `main`
  stays the same node. `Retention.work` counts examined rows and SDK entry
  Tree builds per frame, not just emitted wire operations.
- Keep the dock/layer and incremental history in **one Surface.send frame**,
  subject to the SDK's real ACK credits. Do not poll the terminal or invent
  viewport, scroll-end or history-request events.
- Interpret `gone.ids` only for this surface. Do not send operations against
  fully evicted historical roots. A cold entry does not resurrect on new tokens.
  Keep original entry IDs, including after a manual history reload.
- The **Load older history** action or **Ctrl+Home** explicitly restores up to
  **40** evicted entries, maintaining order. Keep the current reading page
  un-settled, then release it when another page is requested.
- Rebuild action routing on execution only for the addressed row. Queued handlers
  verify the current live `Transcript.entries` identity and reset/load lifetime
  **before the next paint**, along with partial/full gone state. Evicted native
  IDs must not receive actions.
- A welcome logo/tip or late `session.info.version` update refreshes its
  resident welcome row. A changed Copy handler identity refreshes resident
  prompt/answer handlers; the copied-ID indicator refreshes only its two
  affected rows. Evicted history is never resurrected for context changes.
  Wall-clock `now` deliberately freezes age labels at the first projection.
- Without `settle`, keep the existing `SurfaceHost.render` behavior.

Tern SDK 0.1.0 has `Surface.send`, `Surface.settle`, `View.ops`, `Tree`,
and `gone`, but **does not have** a viewport-range, lazy-scroll request, or
entry adoption API; automatic scroll-triggered history paging is not claimed.

## Qualification

Run on OMP's machine with a prepared Hermes source checkout:

```sh
cd frontend
bun run setup
bun install --frozen-lockfile
bun run check
bun run test src/__tests__/retention.test.ts
bun bench/retention.ts
bun run bundle
```

Then run an **isolated** real Tern/Hermes pane with a throwaway
`HERMES_HOME`; verify:

1. Fresh and resumed sessions, including 200 and 2,000 history entries.
2. Running tools, waiting approvals, failed/interrupted turns and subagents.
3. Streaming deltas, compactions, late old-turn updates and Copy/rewind gestures.
4. Actual `gone` eviction (including a partial subtree) and manual
   Load older history / Ctrl+Home; untouched native scroll and composer cursor.
5. Credit=1, hidden→visible, resize, detach, quit, and no-settle fallback.

The Vitest suite and off-host benchmark are **unexecuted source submissions**:
this connector-only worker cannot run Bun, a real terminal or a native Tern
pane. `bench/retention.ts` replays the production writer and SDK Tree/View/Op
path with a one-credit ACK-controlled fake transport: **200 and 2,000 entries**,
**5,000 token deltas per run**, **five fresh interleaved runs per size**,
and the **same one-ACK-per-emitted-frame cadence**. It measures SDK entry-tree
builds, inspected rows, TSP op counts and serialized wire bytes, and reports
cold-upload p95/bytes separately from steady p50/p95/bytes. The script exits
nonzero unless **2,000-entry steady p95 <= 1.5 × 200-entry steady p95** and
constant per-token examined/build counts and final root identities hold. This
does not prove actual native host render latency; OMP must record the real
command output on the exact PR head before promotion.

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
