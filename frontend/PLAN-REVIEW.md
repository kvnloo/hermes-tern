# Hermes for Tern: plan review and todo HUD

Source: the existing Hermes TSP frontend in kvnloo/hermes-agent,
preview/tern-frontend (ui-tsp/PLAN-REVIEW.md, src/plan.ts,
src/todo-hud.ts and their tests). Adapted to hermes-tern's existing
frontend/src/ command, overlay, gateway and dock architecture.

## Plan review

Bare /plan opens a modal review of the most recent *completed*
heading-structured assistant answer. Markdown from user messages, tool
results, fenced code and incomplete turns cannot establish a plan. A
backend plan without headings is still reviewable.

The frontend first checks session-attached `gateway.capabilities.plugin_methods` for every
`hermes-tern.plan.*` method, then calls `hermes-tern.plan.status`. Neither
an older unnamespaced `plan.status` nor an absent method confers authority.
Older gateways explicitly show “Needs Hermes plugin gateway methods for plan review.” A completed
heading-structured assistant candidate offers **Continue (ordinary prompt)**
and **Refine** when the RPC is missing/incompatible, or when an authoritative
status has no plan and plan mode is disabled. Continue sends the exact
`Approved — proceed with the plan.` prompt; refinement sends
`Refine the plan: <feedback>`. Neither action approves a revision, enables
plan mode, edits plan status or implies execution. If planning mode is enabled
or generation is in progress, these ordinary decisions are not available.

The frontend sends these through the existing typed command host:
`control().send` while idle and `control().enqueue` while busy. Both use
the existing PromptRouter with app-owned text and empty images; they never
take the composer draft or its attachments, and a busy decision cannot
unexpectedly steer or redirect the active turn. The button can submit only
once; a closed/replaced/session-stale sheet or an obscuring modal invalidates
its native actions. A later status revision invalidates callbacks captured
from earlier renders.

With an **eventually compatible** authoritative backend, only the gateway may
enable planning mode, edit/annotate, refine or approve a revision. The current
backend declines all such operations; no plan is ever reported as approvable. Approval never submits a prompt.

Authoritative requests carry the live session ID and exact plan_id/revision.
Busy turns, unavailable sessions, hidden/replaced sheets, duplicate clicks,
concurrent operations and outdated revisions cannot send an authoritative
decision. The backend must independently reject stale requests. Editor input
and every captured native action require the topmost live sheet and the
rendered revision. Late external editor completion after another modal takes
focus is discarded *before* the plan.edit RPC. Editors use a separate input
state or a private temporary file; neither replaces the hidden prompt editor.
/plan <task> continues to use the backend slash command to generate a plan.

**Existing PromptRouter recovery caveat:** while accepted ordinary prompts
leave the main draft/caret/attachments unchanged, the shared router and queue
restore an app prompt to the composer after a rejected/withdrawn admission.
Strict draft/caret immutability under *transport failure* therefore needs an
explicit failure-recovery policy in the shared prompt ports
(`frontend/src/commands/host.ts`, `frontend/src/turn/router.ts`,
`frontend/src/turn/queue.ts`, `frontend/src/app/actions.ts`), owned by
OMP. This slice does not work around that by calling `prompt.submit`
directly, mutating the composer or bypassing PromptRouter.

The plan backend/policy remains blocked on a public Hermes lifecycle and
execution-policy contract. This plugin intentionally offers no authoritative
planning mode while that prerequisite is absent.

## Current backend safety gate

The Python plugin registers five **owned, strict-schema** RPCs on Hermes cores
supporting `PluginContext.register_gateway_method`:
`hermes-tern.plan.status/mode/edit/annotate/decide`. Their
`gateway.capabilities.plugin_methods` inventory is session-attached, not
sessionless. This release returns **supported=false** on status; every mutation
is refused with code 4094. This is deliberate, not a completed plan backend.
Older cores do not register these methods, so the renderer stays inspection
only. The ordinary Continue/Refine buttons are normal user prompts and not
revision approval or execution authorization.

**Why no plan mode yet (pinned core `0ac4e9df39eecf3ce69a3ea3c80a6dc70dd7dcd5`):**
`hermes_cli/plugin_gateway_methods.py:GatewayRequestContext` exposes the live
RPC session ID, profile, `assert_attached` and `capture_scope`, but not a public
trusted association to the executing agent's session/task, its busy/accepted
turn identity, or its successful terminal outcome. Its scoped lease has
`assert_current` and `assert_caller(current_request)`; these attest the
original RPC caller, not agent turn completion. In the **legacy** handler,
`tui_gateway/methods_session.py:_create_session` independently generates
`session_id` and `stored_session_id`. The accepted turn/owner IDs and
completion are managed privately by `tui_gateway/prompt_turn.py:_run_prompt_submit`.
The canonical backend follows another session authority path and cannot be
projected by borrowing legacy private state.

`hermes_cli/middleware.py:run_tool_execution_middleware` invokes plugin
middleware before the pre-tool hook, guardrails and approvals
(`agent/tool_executor.py:_hermes_pipeline`). Middleware exceptions before
`next_call` continue to the real tool; no public plan-guard attestation binds
both sequential and concurrent execution, including provider-owned and isolated
compute calls, to a protected current turn. The public hook catalog also lacks
a trusted accepted-turn terminal event carrying exact plan body and status.
Until the core adds those public contracts, a plugin must not enable a
planning-only policy, synthesize successful completion, record approval or
inject approved bytes into the next user turn.

The tested design donor in
`kvnloo/hermes-agent@724b2aaec5981eb264f65923f72858faff27bb5b`
contains `tui_gateway/plan_review.py`, `methods_plan.py` and
`agent/plan_mode.py` *inside core*, not a supported standalone plugin
lifecycle. Those private session/agent mutations must not be copied or
monkeypatched. A future independently reviewed core contract must cover
accepted-turn start/end, immutable owner/task mapping, planning-only policy at
both tool boundaries (including wrapper batches), strict provider/compute
refusal, and next-user-turn exact reviewed bytes before guarded mutations can
be activated.

## Todo HUD

The existing plugin renders Tern checklist nodes and a collapsible todo pill.
A separate per-session, bounded snapshot (24 sessions) now takes
todo.updated events, including empty snapshots. A newly adopted stored
session restores its latest historical tool snapshot if none was cached.
The persistent transcript's settled tool cards are not retroactively changed
by a later todo event. Completed todo lists disappear once the turn ends;
pending/in-progress rows remain. Switching sessions resets dock expansion,
without leaking another session's plan.

## Attribution and validation

Gateway/runtime and plan policy: NousResearch Hermes and contributors.
TSP/SDK and OMP interaction vocabulary: Can Bölük and Stencil contributors.
Plugin UI and dock architecture: alt-glitch and hermes-tern contributors.
Original ui-tsp frontend port donors: contributors of kvnloo/hermes-agent.

From frontend/, point HERMES_SRC at a compatible local Hermes checkout
and run `node scripts/hermes-src.mjs` to prepare the source link without
an unfrozen install, then `bun install --frozen-lockfile`,
`bun run typecheck`,
`bun run test -- src/__tests__/plan-review.test.ts src/__tests__/plan-editor.test.ts src/__tests__/todo-hud.test.ts`,
`bun run check`, and `bun run bundle`.
Separately check a real isolated native Tern pane, idle/busy ordinary
Continue/Refine, modal preemption and late editor completion, with a Hermes
gateway both with and without plan.status support. A successful frontend suite
cannot demonstrate planning-only tool-policy enforcement.
