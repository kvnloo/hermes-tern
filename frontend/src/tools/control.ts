// The ask_control tool's detail: the control it showed (Ripple's fast-control schema) or why the
// tool refused it. The live result carries the control as the plugin checked it; a stored call may
// come back without its result, so the args are read the same way then.

import { type FastControl, parseFastControl } from '../vendor/ripple/index.js'
import { record } from '../wire/json.js'

import { type Raw, text } from './fields.js'

/** The tool's name, as the plugin registers it (controls.py). */
export const CONTROL_TOOL = 'ask_control'

/** An `ask_control` call, read once. */
export interface ControlDetail {
  tool: 'ask_control'
  /** The control, or undefined when neither the result nor the args hold a valid one. */
  control: FastControl | undefined
  /** The tool's error (a control outside the schema, no pane to show it in). */
  error: string | undefined
}

/** `raw` without its null fields, at the top and in its rows: models send null for an absent option. */
function withoutNulls(raw: Record<string, unknown>): Record<string, unknown> {
  const rows = (v: unknown) => (Array.isArray(v) ? v.map(r => (record(r) ? withoutNulls(record(r) ?? {}) : r)) : v)

  return Object.fromEntries(
    Object.entries(raw)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, k === 'options' || k === 'candidates' ? rows(v) : v])
  )
}

export function controlDetail({ args, result }: Raw): ControlDetail {
  const error = text(result?.['error'])
  const control = parseFastControl(record(result?.['control']) ?? withoutNulls(args)) ?? undefined

  return { control: error ? undefined : control, error, tool: 'ask_control' }
}
