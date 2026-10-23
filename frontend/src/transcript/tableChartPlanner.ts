// Table planning through the existing Hermes Python helper seam (see processes/widgets/author.ts).
// The pinned shared gateway has no table_chart.plan RPC. Only the table goes on stdin;
// Hermes redacts it before calling its configured auxiliary.table_charts route.
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import type { ChartKind, ChartPlanner } from './tableCharts.js'

export const TABLE_CHART_DEADLINE_MS = 5000
const MAX_REPLY_BYTES = 4096

/** Reject any prose, SVG, tool output or unknown kind from the auxiliary subprocess. */
export function readTableChartReply(stdout: string): ChartKind {
  // Match widget_author.py's transport: Python dependency activation may
  // print diagnostics before the one final JSON line.
  const data: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')

  if (typeof data === 'object' && data !== null && !Array.isArray(data) &&
      Object.keys(data).length === 1 && 'kind' in data &&
      (data.kind === 'bar' || data.kind === 'line' || data.kind === 'none')) {
    return data.kind
  }

  throw new Error('Invalid table chart helper reply')
}

/**
 * A single provider attempt. The launcher's exact Hermes interpreter/checkout and
 * installed plugin path are the same ones that run widget_author.py. An absent
 * launcher seam rejects (TableCharts retains its local bar).
 */
export function hermesTableChartPlanner(env: NodeJS.ProcessEnv = process.env): ChartPlanner['plan'] {
  const python = env['HERMES_PYTHON']?.trim()
  const root = env['HERMES_PYTHON_SRC_ROOT']?.trim()
  const ui = env['HERMES_TUI_DIR']?.trim()

  return async (_session, table, signal) => {
    if (!python || !root || !ui) {
      throw new Error('Hermes Python auxiliary route is unavailable')
    }

    if (signal.aborted) {
      throw new Error('Table chart request cancelled')
    }

    const script = join(ui, '..', 'table_chart_planner.py')
    const deadline = AbortSignal.timeout(TABLE_CHART_DEADLINE_MS)
    const combined = AbortSignal.any([signal, deadline])

    return new Promise<ChartKind>((resolve, reject) => {
      // Absolute wall-time cap, including interpreter startup. SIGKILL prevents
      // a non-cooperative child from lingering after the deadline or session loss.
      const child = spawn(python, [script], {
        cwd: root,
        env: { ...env, PYTHONPATH: root },
        signal: combined,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: TABLE_CHART_DEADLINE_MS,
        killSignal: 'SIGKILL'
      })
      let stdout = ''
      let error: Error | undefined

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk

        if (Buffer.byteLength(stdout) > MAX_REPLY_BYTES) {
          error = new Error('Table chart helper reply exceeded its limit')
          child.kill('SIGKILL')
        }
      })
      child.on('error', (reason: Error) => {
        error = reason
      })
      // A closed stdin is expected when the script exits before accepting input.
      child.stdin.on('error', () => undefined)
      child.on('close', code => {
        if (error || combined.aborted || code !== 0) {
          reject(error ?? new Error('Table chart helper cancelled, timed out or exited'))
          return
        }

        try {
          resolve(readTableChartReply(stdout))
        } catch (reason) {
          reject(reason)
        }
      })
      child.stdin.end(JSON.stringify({ source: table.source }))
    })
  }
}
