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
    bun run setup
    bun run typecheck
    bun run test src/__tests__/btwSheets.test.ts src/__tests__/operationalSheets.test.ts
    bun run check
    bun run bundle

On a compatible Hermes gateway, smoke /btw (list, start, follow up, cancel,
switch session, stale reply) and /mcp status, /ssh list, and unsupported
/mcp add /ssh remove. Verify no side turns enter the main transcript and no
management action is emitted.
