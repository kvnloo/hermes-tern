# Native BTW and operational report sheets

Hermes remains the authority: the Tern frontend does not persist side questions,
replay prompts, authenticate MCP/SSH, open sockets, or write inventory.

## BTW

- /btw opens session-owned history; /btw <question> starts a new side thread.
- The modal has independent history and reader panes plus a per-thread editor.
  Tab cycles panes, Ctrl+N/P moves between threads, Alt+Enter or Enter from
  the editor sends, Ctrl+X cancels the selected running side turn, Esc closes,
  and Copy sends only the selected side thread through the existing clipboard.
- Clicking the native side editor acquires composer focus through its public
  Tern click action even at unchanged caret, without a synthetic edit.
  Reader/history navigation still starts in the reader; Tab remains unchanged.
  Real typing, Unicode, bracketed paste and Enter use the existing Composer key path.
- Native editor click/edit/send/undo and selection-owned Send/Stop/Copy buttons
  share a monotonic presentation ID for the exact selected draft, session and
  sheet lifetime. Tern focus uses that same editor key. IDs remain stable across
  ordinary typing and same-owner renders, but rotate on selection ABA, selected
  turn replacement, same-ID re-adoption, sheet close/reopen or replacement and
  session switch. Captured callbacks retain the old session/selection/draft/ticket
  guard; after a new render an old native ID cannot retarget a newer handler.
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
  The dock delegates notice markup to `src/view/btwNotices.tsx`;
  `BtwThreads` retains all ownership checks and notice state.
- Native View/Dismiss actions capture thread/session/notice identity and a
  presentation ticket, refusing queued actions after selection, adoption,
  dismissal, overlay close/replacement or a new owner; modal approvals keep
  precedence. Main text, caret, images, transcript and side drafts are not
  used as completion storage. `background.complete` keeps its prior main
  transcript panel. No new RPC, synthetic event, polling or timer is added.

## Backend compatibility

The frontend source is still pinned to
22063fc099ec9ad8357d7f8f6e6248a0400680d3. This is NOT a Hermes
runtime upgrade. The public green gateway seam is downstream
[hermes-agent#650](https://github.com/kvnloo/hermes-agent/pull/650)
at 0ac4e9df39eecf3ce69a3ea3c80a6dc70dd7dcd5.
The plugin registers only hermes-tern.operations.report when the installed
Hermes exposes ctx.register_gateway_method. The frontend checks the
attached session's gateway.capabilities.plugin_methods before issuing any
namespaced request. Older runtimes show "Needs Hermes plugin gateway
methods", not fabricated side history or operational inventory.

Read-only MCP list/status/catalog uses real profile config, Hermes'
public cached connection status reader and the existing catalog. It does
not connect/authenticate/probe/install/reload. MCP tool names and effective
SSH identity are NOT available via a public profile-owned ledger API;
those views explicitly say unavailable, never an invented empty list.

BTW's registered method names would be hermes-tern.btw.list,
hermes-tern.btw.submit, hermes-tern.btw.cancel, plus the event
hermes-tern.btw.update via the authenticated plugin.event envelope.
They are NOT registered yet: GatewayRequestContext publicly exposes a
live transport SID, profile, assert_attached and capture_scope only; not
the authenticated durable conversation ID/metadata handle, main transcript
snapshot or tool-less provider fork. The live RPC SID and durable stored SID
and built agent/tool session ID are distinct authority domains. Mapping them
by guessed path or private server records is prohibited. Kevin/alt-glitch
must decide and expose the public ownership/provider seam before persistent
side turns, their cancellation or streamed updates can be claimed.

Frontend FakeGateway tests prove presentation and routing only, NOT
backend functionality. OMP must run Python integration against that exact
green core seam using isolated HERMES_HOME and on-disk profile config,
then real native Tern in owned headless Sway; keep the existing MBP
five-second environment deadlines unchanged.

## Verification and PTY scope

The BTW PTY regression uses actual OS PTY bytes and raw-mode Node. On Linux it
uses util-linux `script -q -c ... /dev/null`; on macOS it uses BSD
`script -q /dev/null node -e ...`. It verifies split four-byte UTF-8,
Unicode, bracketed multiline paste and Enter through the existing test
Tern-key adapter, App, Composer and PromptRouter. The test **fails** if
`script(1)` cannot start; it is not Linux-skipped. It checks the BTW side
draft, main draft, gateway submit payloads and transcript isolation.

The `btwNativeInput.test.ts` regression constructs the pinned real Tern
Session/Surface with a TSP handshake; it uses native SDK editor action
dispatch at unchanged caret, raw typed Unicode, bracketed paste/Enter,
serialized focus and stale-action rejection. It also decodes emitted TSP frame
JSON, captures the real native editor and Send IDs, and injects old IDs over
Session's incoming APC event path **after** the new selection is rendered;
A→B, A→B→A, same-ID adoption/replacement and fresh B controls are checked.
This in-process SDK test is not
a GUI mouse or compositor test. OMP must repeat the actual isolated Sway
Tern 0.9.5 click at unchanged caret, raw paste of ` paste 🦉 café 漢字`,
Enter, Tab and Esc/reopen, checking that main draft stays untouched.

The existing `btwPty.test.ts` is **PTY-to-App adapter integration**,
not a native Tern SDK parser or window test. Neither the PTY adapter nor
the new in-process SDK regression proves native compositor acceptance.
OMP owns separate real Tern proof with the installed SDK and an isolated
Hermes profile. No backend support is inferred from mock gateway replies.

OMP validation (not run by this connector-only implementation worker):

    cd frontend
    node scripts/hermes-src.mjs
    bun install --frozen-lockfile --prefer-offline
    bun run check
    bun run test src/__tests__/btwSheets.test.ts src/__tests__/btwNotices.test.ts src/__tests__/dockModel.test.ts src/__tests__/dispatch.test.ts src/__tests__/chrome.test.ts src/__tests__/btwPty.test.ts src/__tests__/operationalSheets.test.ts src/__tests__/generalReportSheets.test.ts src/__tests__/commands.test.ts src/__tests__/sessionLifecycle.test.ts src/__tests__/composer.test.ts src/__tests__/slashRouting.test.ts src/__tests__/watch.test.ts src/__tests__/btwNativeInput.test.ts
    bun run bundle

On a compatible Hermes gateway, smoke /btw (list, start, follow up, cancel,
switch session, stale reply) and /mcp status, /ssh list, and unsupported
/mcp add /ssh remove. Verify no side turns enter the main transcript and no
management action is emitted.
