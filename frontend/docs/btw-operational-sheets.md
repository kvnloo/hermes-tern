# Native BTW and operational report sheets

Hermes remains the authority: the Tern frontend does not persist side questions,
replay prompts, authenticate MCP/SSH, open sockets, or write inventory.

## BTW

- /btw opens session-owned history; /btw <question> starts a new side thread.
- The modal has independent history and reader panes plus a per-thread editor.
  Tab cycles panes, Ctrl+N/P moves between threads, Alt+Enter or Enter from
  the editor sends, Ctrl+X cancels the selected running side turn, Esc closes,
  and Copy sends only the selected side thread through the existing clipboard.
- The main draft and main transcript are untouched. Each thread, including the
  new-thread slot, keeps its unsent text and cursor while the same live session
  is shown; adopting another session drops every side draft and closes its sheet.
- Replies and btw.update snapshots use the exact gateway session ID. Newer
  revisions beat late list/submit/cancel results. An obsolete sheet, overlaid
  approval or completed session switch cannot send a stale action.
- List, submit and cancel use btw.list, btw.submit and btw.cancel. Older gateways
  return an explicit unavailable state; never silently fall back to prompt.btw
  because that older method has different one-shot transcript semantics.

## MCP and SSH

- The only supported routes are /mcp [list|status|tools|catalog] and /ssh [list].
  Each view is an operations.report read for the current live session.
- Every other argument is visibly unsupported and sends no RPC. No implicit
  slash.exec, remote probes, mutations, credentials or connection operations.
- Backend rows are escaped before native Markdown presentation. The scope and
  read-only status are explicit; unavailable does not pretend an empty list.
  Exceptions are redacted, a stale reply cannot replace another sheet, and
  keyboard scrolling/copy stay scoped to the sheet.

## General read-only report sheets

- `/usage`, `/context`, `/history [chars]`, `/tools [list]`,
  `/help [command]` and bare `/status` use native reports without new
  main transcript panels. Bare `/help` preserves its native shortcuts UI.
  History uses the existing local preview; tools uses real `tools.show`.
- Output is authorized by the typed command, not the contents of an arbitrary
  slash reply. Mutating `/compress`, unsupported `/tools` forms, unknown
  commands, skills and dispatch actions retain their old transcript/actions.
  MCP/SSH inventory remains separately backend-owned and namespaced.
- Native copy preserves exact report-only bytes, including Unicode and trailing
  newlines. Loading, close, replacement, approval and session fences prevent
  late reports from resurrecting private state; scroll is overlay-scoped.
  The main draft/caret, transcript and main scroll are unchanged.
- Real `background.complete` and `btw.complete` completion-notice View
  actions remain a separate shared gateway/dock slice, serialized with other
  owners; their existing transcript behavior is not changed by this PR.
  No synthetic completion RPC or event is introduced.

## Backend compatibility

The plugin currently pins Hermes source at
22063fc099ec9ad8357d7f8f6e6248a0400680d3 in frontend/hermes-src.lock.
That generated gateway contract predates btw.list / submit / cancel / update
and operations.report. This PR intentionally does not change the pin or
pretend those methods exist. To activate the surfaces, coordinate a separate
pinned-Hermes update that includes those real backend contracts and services
then rerun the full frontend check and integration smoke test on that gateway.

OMP validation (not run by the implementation worker):

    cd frontend
    node scripts/hermes-src.mjs
    bun install --frozen-lockfile
    bun run typecheck
    bun run test -- src/__tests__/btwSheets.test.ts src/__tests__/operationalSheets.test.ts src/__tests__/generalReportSheets.test.ts src/__tests__/commands.test.ts
    bun run check
    bun run bundle

On a compatible Hermes gateway, smoke /btw (list, start, follow up, cancel,
switch session, stale reply) and /mcp status, /ssh list, and unsupported
/mcp add /ssh remove. Verify no side turns enter the main transcript and no
management action is emitted.
