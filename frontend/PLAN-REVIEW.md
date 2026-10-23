# Hermes for Tern: plan review and todo HUD

Source: the existing Hermes TSP frontend in kvnloo/hermes-agent,
preview/tern-frontend (ui-tsp/PLAN-REVIEW.md, src/plan.ts,
src/todo-hud.ts and their tests). Adapted to hermes-tern's existing
frontend/src/ command, overlay, gateway and dock architecture.

## Plan review

Bare /plan opens a modal read-only review of the most recent *completed*
heading-structured assistant answer. Markdown from user messages, tool
results, fenced code and incomplete turns cannot establish a plan. A
backend plan without headings is still reviewable.

The frontend asks the live session for plan.status. When the installed
Hermes gateway lacks that RPC or returns an incompatible shape, the sheet
explicitly says plan authority is unavailable and provides *inspection only*:
no approval, refinement, mode toggle or plan mutation is inferred from text.
With authoritative status, only the gateway can enable planning mode,
edit/annotate a revision, refine or approve it, via plan.mode,
plan.edit, plan.annotate and plan.decide.

Every consequential request carries the live session ID and, for an existing
plan, its exact plan_id and revision. Busy turns, unavailable sessions, stale
or replaced sheets, duplicate clicks, concurrent pending operations and
outdated revisions cannot send a decision. The backend must independently
reject stale requests. Approval never implicitly submits an execution prompt.
Editors use a separate input state or a private temporary file; neither
replaces the hidden prompt editor. /plan <task> continues to use the backend
slash command to generate a plan.

This plugin does not implement the gateway's planning-only tool policy. It
relies on the *actual* Hermes gateway to enforce it. Plan review must not be
advertised as authoritative on a Hermes checkout lacking those RPCs.

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

From frontend/, point HERMES_SRC at a compatible local Hermes checkout and
run bun run setup, bun run typecheck, bun run test, bun run lint, bun run check,
then bun run bundle. Separately check a real isolated Tern pane and Hermes
gateway with and without plan.status support; these checks are not replaced
by Vitest. Never assume passing unit tests proves the gateway's policy.
