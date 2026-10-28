// The terminal tool's detail: the command, how it ran, and what it printed; and a command without
// the plugin's Tern pane prefix, as every view and store shows it.

import type { ToolCall } from '../model.js'

import { num, type Raw, text } from './fields.js'

/** A `terminal` call, read once. */
export interface TerminalDetail {
  tool: 'terminal'
  /** The command, when the args name one (a view falls back to the call's context). */
  command: string | undefined
  /**
   * It started a background process: asked to (`background: true`), or moved there by Hermes (a
   * long timeout, a message arriving mid-run), whose result then names the process.
   */
  background: boolean
  output: string | undefined
  error: string | undefined
  /** The exit code, when the result has one. */
  exit: number | undefined
  /** Exact pinned foreground recreation signal; it does not prove which state survived. */
  environmentRecreated: boolean
}

// Pinned Hermes emits this exact fixed text, not a boolean or arbitrary warning.
const RECREATED_SIGNAL = 'The execution environment was recreated while running this command ' +
  '(the previous container/sandbox was gone). Persistent files were restored ' +
  'where the backend supports it, but background processes and any files ' +
  'outside persisted paths from earlier commands may be lost — verify state ' +
  'before relying on prior work.'

function recreation(result: Raw['result']): boolean {
  if (!result || !Object.hasOwn(result, 'environment_recreated') || result['environment_recreated'] !== RECREATED_SIGNAL) return false
  return Object.hasOwn(result, 'output') && typeof result['output'] === 'string' &&
    Object.hasOwn(result, 'exit_code') && typeof result['exit_code'] === 'number' && Number.isSafeInteger(result['exit_code']) &&
    Object.hasOwn(result, 'error') && result['error'] === null
}

export function terminalDetail({ args, result }: Raw): TerminalDetail {
  return {
    background: args['background'] === true || typeof result?.['session_id'] === 'string',
    command: text(args['command']),
    error: text(result?.['error']),
    environmentRecreated: recreation(result),
    exit: num(result?.['exit_code']),
    output: text(result?.['output']),
    tool: 'terminal'
  }
}

/** A settled, foreground warning can be promoted without changing the call outcome. */
export function terminalRecreationNeedsAttention(call: ToolCall, detail: TerminalDetail): boolean {
  return call.outcome.kind !== 'running' && !detail.background && detail.environmentRecreated
}

/**
 * The prefix the plugin's `tool_request` middleware puts before a command so it runs with the chat's
 * Tern pane (`tern_env.py`): `export TERN_PANE=… …;` and/or `unset TERN_…;`. It is not what the agent
 * wrote, so the views and the stores leave it out.
 */
const TERN_ENV = /^\s*(?:export (?:TERN_[A-Z_]+=(?:'[^']*'|"[^"]*"|[^\s;]+) ?)+; ?)?(?:unset (?:TERN_[A-Z_]+ ?)+; ?)?/

/** `command` without the plugin's Tern pane prefix. */
export function withoutTernEnv(command: string): string {
  const m = TERN_ENV.exec(command)

  return m?.[0] ? command.slice(m[0].length) : command
}
