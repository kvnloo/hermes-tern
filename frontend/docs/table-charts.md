# Automatic charts for settled Markdown tables

Ported from the Hermes × Tern `ui-tsp` implementation (original work by the Hermes/Tern contributors; Tern SDK by Can Bölük/Stencil). The plugin appends a native SVG fence below an eligible two-column table without mutating its transcript, stored messages, or Copy result. Tern resolves the CSS semantic palette tokens when drawing.

## Enable

Add `"tableCharts": "always"` to the profile's `~/.hermes/hermes-tern/settings.json` (or the equivalent under `HERMES_HOME`). The default is `"off"`. The setting is read when adopting the next runtime session; reopen the pane to apply a change to its current session.

- `off`: original Markdown only; zero planning requests.
- `always`: draw a local bar chart; zero planning requests.
- `smart`: immediately draw a local bar, then ask the optional Hermes `table_chart.plan` RPC for `bar`, `line`, or `none`. If the gateway doesn't provide this RPC, rejects the request, or replies with invalid data, keep the local bar. Smart mode sends each admitted table to the gateway's configured auxiliary model; enable it only when that data flow is appropriate.

Eligibility is deliberately narrow: 2–24 rows, exactly two pipe columns, nonnumeric unique category labels and finite decimal values (or consistent percentages); no fenced/indented/nested tables, mixed units, commas, exponent notation, escapes, zero-only columns, or multi-series guesses. Analysis caps each Markdown block at 64 KiB, each candidate at 8 KiB and each block at 8 charts. The session cache holds 128 distinct table sources; smart mode admits at most 8 plan requests per session and one at a time. Hermes server-side planning limits (including request deadline) remain the gateway's responsibility.

These are presentation-only fences in assistant turns that have settled successfully. In-flight assistant Markdown and failed/interrupted turns stay untouched. Session switches and policy changes invalidate pending plans and derived chart caches.

## OMP verification

From `frontend/`, after the project-specific setup described in `frontend/README.md`:

    bun run typecheck
    bun run test -- src/__tests__/tableCharts.test.ts
    bun run check

Native Tern smoke: confirm one eligible settled answer charts in `always`, no chart during streaming, theme changes recolor it, a resumed answer charts again, `off` leaves the table alone, and `smart` without its optional backend route uses the bar fallback. This manual/native check is not replaced by vitest.
