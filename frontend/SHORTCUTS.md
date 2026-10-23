# Shortcuts, palette and model navigation (Tern frontend)

This port uses the existing Hermes Tern gateway, app ports, native `@stencil-hq/tern` picker and `/model` switch contract. No new persistence or model routing authority is introduced.

## Shortcuts

| Chord | Action |
| --- | --- |
| Alt+A / Alt+J / Alt+P / Alt+S | Agents / background / PRs / sidebar (the plugin's original bindings) |
| Shift+Tab | Cycle reasoning effort |
| Alt+Up / Alt+Enter | Edit oldest queued prompt / steer queued prompt while busy |
| Alt+M | Select model (session-aware native picker) |
| Ctrl+P / Ctrl+Shift+P | Next / previous recent model |
| Ctrl+Shift+K | Native command palette |
| F1 / Alt+/ | Help and current bindings |
| /palette | Open the command palette |

Ctrl+C, Ctrl+D, Ctrl+V, Esc Esc and the composer's readline keys remain owned by their existing handlers. The overlay stack, modal questions, HUD and completion keep precedence. In particular, Alt+P still opens **pull requests**, not the donor frontend's temporary model selector.

## Owning-profile bindings

On each session adoption the frontend reads `settings.get` from that exact Hermes gateway session. The optional `display.tern_keybindings` field maps **action IDs** from `src/shortcuts/actions.ts` to a chord, string array, `null` (default), or empty array (disabled). The optional `display.tern_profile_identity` exposes the owning profile to the session-bound binding store.

Example:

```json
{
  "app.palette": ["ctrl+shift+k", "alt+k"],
  "app.model.select": "alt+m",
  "app.help": null
}
```

The settings shown above are the *value* of the owning gateway's `display.tern_keybindings` field, not a new plugin settings file. Invalid or overlapping bindings are rejected atomically, with defaults for a new session and the previous valid map preserved for the current session. Host-reserved chords and composer-owned keys cannot be rebound. A delayed response from another session is ignored. No profile settings are written by this port.

## Command palette

`/palette` and Ctrl+Shift+K open a modal Tern `picker`. It searches the existing local command registry and the gateway's `commands.catalog`, excluding hidden/refused commands and duplicates. **Enter** explicitly runs the selected slash command through the existing dispatcher; **Tab** inserts it into the draft without submitting; **Esc** closes without changing the draft. A stale gateway catalog cannot change the new session's palette.

## Model navigation

Model cycling asks `model.options` for available, authenticated models with `safe_inventory` and respects the gateway's pending model intent. Recent accepted selections are local navigation memory (per pane and session, maximum 32); they never change the configured default. If no usable recent shortlist exists, cycling uses the authorized inventory. Every switch uses the existing `switchModel` path and its expensive-model confirmation; no direct model mutation bypasses that guard. The picker flags recent models and the switch path fences late responses from prior sessions.

## OMP verification (not run by this worker)

From the repository root:

```sh
cd frontend
bun run setup
bun run typecheck
bun run test src/shortcuts/actions.test.ts src/shortcuts/binding-preferences.test.ts src/shortcuts/model-cycle.test.ts src/shortcuts/palette.test.ts src/__tests__/keys.test.ts
bun run lint
bun run check
```

Also manually verify Tern key input (modified F1, Alt+/ and Ctrl+Shift+K), Enter vs Tab in the palette, model confirmation on both gateway modes, reconnect/session replacement while reads are outstanding, and canonical-gateway `settings.get` behavior.

### Provenance

Adapted from the user's Hermes fork `kvnloo/hermes-agent` at `preview/tern-frontend/ui-tsp/src/actions.ts`, `binding-preferences.ts`, `model-cycle.ts`, `model-recents.ts`, and `SHORTCUTS.md`, and integrated with this plugin's existing `frontend/src/draft/keys.ts`, `overlays/models.tsx`, `overlays/help.tsx`, `commands/local.ts` and Tern SDK. The underlying Tern / OMP interaction conventions originate with Can Bölük / Stencil contributors.
