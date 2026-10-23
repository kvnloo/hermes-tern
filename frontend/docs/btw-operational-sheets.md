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
- A typed /btw <question> stages the literal question in the conversation's
  NEW-thread editor before btw.list. Unsupported or rejected history leaves
  the question visible and unsent; close/reopen retains it. A successful list
  auto-sends only a newly seeded draft whose revision and selection stayed
  unchanged during lookup. Editing or changing selection means manual Send.
  If the new-thread slot already holds an unadmitted draft, the next slash
  question is appended on a new line without discarding its caret or pasted
  content, and must be reviewed and sent manually. Main draft, images,
  transcript and history receive no extra side-question entry; the typed
  slash command itself remains one normal prompt-history entry.

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
- Real terminal `btw.update` snapshots produce dismissible notices in the
  dock, as in the donor's noticed-thread projection; running turns do not
  claim completion. Typed `btw.complete` also updates conversation-owned
  notice state, never Q/A panels in main Transcript. A View action opens only
  the matching gateway-owned side thread; a legacy `task_id` must uniquely
  match a known thread ID or turn ID. Completions can precede `btw.update`;
  unmatched IDs wait for a real thread snapshot and never choose the
  selected/latest thread or infer identity from question text. Same-turn
  duplicates and dismissal never resurrect a notice; a later terminal
  follow-up gets its own notice. Distinct terminal threads retain distinct
  notices even when their turn IDs collide; an ambiguous legacy task ID
  cannot claim either thread.
- Native View/Dismiss actions capture thread/session/notice identity and a
  presentation ticket, refusing queued actions after selection, adoption,
  dismissal, overlay close/replacement or a new owner; modal approvals keep
  precedence. Main text, caret, images, transcript and side drafts are not
  used as completion storage. `background.complete` keeps its prior main
  transcript panel. No new RPC, synthetic event, polling or timer is added.

## Backend compatibility

The plugin currently pins Hermes source at
22063fc099ec9ad8357d7f8f6e6248a0400680d3 in frontend/hermes-src.lock.
That generated gateway contract predates btw.list / submit / cancel / update
and operations.report. This PR intentionally changes neither the pin nor
Hermes core. The held backend slice must implement these plugin-owned,
namespaced methods through the existing generic gateway-method seam (with
real authorization and profile/session ownership). Once available, validate
the real backend, generated frontend contract and native Tern in isolation;
do not treat the mocked fixture replies as persisted-thread or inventory proof.

## Verification and PTY scope

The BTW PTY regression uses actual OS PTY bytes and raw-mode Node. On Linux it
uses util-linux `script -q -c ... /dev/null`; on macOS it uses BSD
`script -q /dev/null node -e ...`. It verifies split four-byte UTF-8,
Unicode, bracketed multiline paste and Enter through the existing test
Tern-key adapter, App, Composer and PromptRouter. The test **fails** if
`script(1)` cannot start; it is not Linux-skipped. It checks the BTW side
draft, main draft, gateway submit payloads and transcript isolation.

This is **PTY-to-App adapter integration**, not real Tern SDK parser, terminal
framing or native window acceptance. OMP owns separate native Tern proof with
the installed SDK and an isolated Hermes profile. No backend support or native
Tern acceptance is inferred from mock gateway replies.

OMP validation (not run by this connector-only implementation worker):

    cd frontend
    node scripts/hermes-src.mjs
    bun install --frozen-lockfile --prefer-offline
    bun run check
    bun run test src/__tests__/btwSheets.test.ts src/__tests__/btwNotices.test.ts src/__tests__/dockModel.test.ts src/__tests__/dispatch.test.ts src/__tests__/chrome.test.ts src/__tests__/btwPty.test.ts src/__tests__/operationalSheets.test.ts src/__tests__/generalReportSheets.test.ts src/__tests__/commands.test.ts src/__tests__/sessionLifecycle.test.ts src/__tests__/composer.test.ts src/__tests__/slashRouting.test.ts
    bun run bundle

On a compatible Hermes gateway, smoke /btw (list, start, follow up, cancel,
switch session, stale reply) and /mcp status, /ssh list, and unsupported
/mcp add /ssh remove. Verify no side turns enter the main transcript and no
management action is emitted.
