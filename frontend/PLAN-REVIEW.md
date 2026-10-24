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

The frontend asks the live session for plan.status. A completed
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

With an authoritative enabled plan, only the gateway can enable planning
mode, edit/annotate a revision, refine or approve it, via plan.mode,
plan.edit, plan.annotate and plan.decide. Approval never submits a prompt.

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

The real plan backend/policy prerequisite is separately held as
`TRN2-HERMES-PLAN-BACKEND`. This frontend correction does not implement
the gateway's planning-only tool policy. It relies on the *actual* Hermes
gateway to enforce it; plan review must not be advertised as authoritative
on a Hermes checkout lacking those RPCs.

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
