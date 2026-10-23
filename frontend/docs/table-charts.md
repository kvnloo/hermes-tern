# Automatic charts for settled Markdown tables

Derived from the Hermes × Tern `ui-tsp` implementation by its original contributors; uses the Tern SDK by Can Bölük / Stencil. The plugin adds a native SVG fence after an eligible, successfully settled assistant Markdown table. The stored answer, transcript, signed sidecars, prompt cache and **Copy** bytes remain the original Markdown; this is a read-only display projection.

## Settings and provider route

Set `"tableCharts": "always"` or `"tableCharts": "smart"` in the active Hermes profile's `hermes-tern/settings.json` (normally `~/.hermes/hermes-tern/settings.json`). Default is `off`. The setting is read on session adoption; reopen a session/pane for an external file edit to take effect.

- `off`: table only. No auxiliary model call.
- `always`: append a locally generated bar SVG. No auxiliary model call.
- `smart`: show the local bar immediately, then let Hermes' **`table_charts` auxiliary route** choose `bar`, `line` or `none`. Invalid replies, no configured provider, spawn failure and provider errors retain the local bar.

**This is implemented in this plugin; it does not depend on `table_chart.plan` or another upstream gateway RPC.** The frontend launches `table_chart_planner.py` using the same `HERMES_PYTHON`, `HERMES_PYTHON_SRC_ROOT` and `HERMES_TUI_DIR` provided by the launcher for `widget_author.py`. The Python helper activates the Hermes dependencies and calls `agent.auxiliary_client.call_llm(task="table_charts", ...)`: `auxiliary.table_charts` in Hermes configuration selects the model, with Hermes' normal auxiliary routing behavior if no explicit override is set.

**Privacy:** In `smart`, the complete eligible table source, **not** the whole answer, goes to the local Hermes Python helper on stdin. The helper calls Hermes' `redact_sensitive_text(force=True)` before passing the table to the configured auxiliary provider. The provider may be remote. This is not an offline/no-disclosure mode; sensitive non-secret table labels/data may leave the computer after redaction. Choose `always` or `off` for tables that must stay local. No provider response, SVG or secrets are inserted into stored answers.

## Eligibility and bounds

Only top-level two-column pipe tables with 2–24 rows, unique nonnumeric category labels, and finite decimal data (or consistent percentages) qualify. Reject fenced/indented/nested tables, mixed units, commas/exponents/escapes, duplicate categories, all-zero values and multi-series guesses. One Markdown block is capped at 64 KiB; at most 8 table candidates per block and 8 KiB per candidate. The per-App derived cache holds at most 128 table sources; no polling is introduced.

Smart mode admits **at most 8 provider attempts per runtime session and 1 concurrent helper**. Each attempt has an absolute **5-second** subprocess deadline (including interpreter startup), and Hermes' provider request also specifies a 5-second timeout and **64 output tokens**. A failed attempt is not retried by the plugin. Mode/session replacement, transport exit and pane disposal abort the subprocess, invalidate its generation and discard stale replies. A change does not reset the 8-attempt admission budget for the same runtime session.

The only accepted helper result is the enum `bar | line | none`. The SVG is always generated locally, with XML-escaped labels and semantic theme tokens that recolor with Tern's palette without new model work. Streaming, interrupted and failed turns never trigger chart planning.

## OMP verification (not yet run)

From `frontend/`:

```sh
bun install --frozen-lockfile
bun run check
bun run test -- src/__tests__/tableCharts.test.ts src/__tests__/tableChartHelper.test.ts
```

From the repo root (the plugin's Python fixture tests, no real model):

```sh
python3 -m pytest -q tests/test_table_chart_planner.py
```

The Vitest helper tests execute the actual `table_chart_planner.py` subprocess using isolated fixture `agent` modules and no credentials or live provider; they also exercise cancellation/deadline. Native Tern should still be checked separately in an isolated pane for streaming/settled/resume/theme/Copy and policy switching. Prior OMP MBP fleet-health exit 75 occurred **before** frontend execution; it is not a test result.
