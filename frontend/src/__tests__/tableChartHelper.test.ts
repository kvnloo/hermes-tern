import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { analyzeTable, TableCharts } from '../transcript/tableCharts.js'
import { hermesTableChartPlanner, readTableChartReply, TABLE_CHART_DEADLINE_MS } from '../transcript/tableChartPlanner.js'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE = join(REPO, 'tests', 'fixtures', 'table_charts')
const UI = join(REPO, 'frontend')
const TABLE = '| Category | Revenue |\n| --- | --- |\n| Alpha | 10 |\n| Beta | 25 |'
const parsed = analyzeTable(TABLE)

function route(scenario: string) {
  // The actual shipped adapter launches the actual shipped Python script;
  // PYTHONPATH resolves fixture providers, not credentials or a live model.
  return hermesTableChartPlanner({
    ...process.env,
    HERMES_PYTHON: process.env['HERMES_PYTHON'] || 'python3',
    HERMES_PYTHON_SRC_ROOT: FIXTURE,
    HERMES_TUI_DIR: UI,
    TABLE_CHART_FIXTURE_OUTPUT: scenario
  })
}

describe('table chart Python auxiliary transport (fixture provider)', () => {
  it.each(['bar', 'line', 'none'] as const)('uses the configured task and accepts only %s', async kind => {
    expect(parsed).toBeDefined()
    if (!parsed) { return }
    await expect(route(kind)('owned-session', parsed, new AbortController().signal)).resolves.toBe(kind)
  })

  it.each(['invalid content', '<svg>unsafe</svg>', 'raise', 'unavailable'])('keeps the local bar for %s', async reply => {
    expect(parsed).toBeDefined()
    if (!parsed) { return }
    await expect(route(reply)('owned-session', parsed, new AbortController().signal)).resolves.toBe('bar')
  })

  it('rejects forged reply envelopes', () => {
    expect(() => readTableChartReply('{"kind":"line","svg":"<script />"}')).toThrow()
    expect(() => readTableChartReply('{"kind":"scatter"}')).toThrow()
    expect(() => readTableChartReply('not JSON')).toThrow()
    expect(readTableChartReply('helper diagnostics\n{"kind":"line"}')).toBe('line')
  })

  it('never starts Python in off or always mode', () => {
    const planner = vi.fn(route('line'))
    const charts = new TableCharts({ policy: async () => 'off', plan: planner }, () => undefined)

    charts.configure('off')
    charts.markdown(TABLE, true)
    charts.configure('always')
    expect(charts.markdown(TABLE, true)).toContain('<rect')
    expect(planner).not.toHaveBeenCalled()
  })

  it('kills a pending provider on session or policy replacement', async () => {
    expect(parsed).toBeDefined()
    if (!parsed) { return }
    const cancel = new AbortController()
    const pending = route('slow')('owned-session', parsed, cancel.signal)
    cancel.abort()
    await expect(pending).rejects.toThrow()
  })

  it('enforces an absolute five-second deadline, including the subprocess', async () => {
    expect(parsed).toBeDefined()
    if (!parsed) { return }
    const started = Date.now()
    await expect(route('slow')('owned-session', parsed, new AbortController().signal)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(TABLE_CHART_DEADLINE_MS + 2500)
  }, 9000)
})
