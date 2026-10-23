// Private, revision-bound draft editing. Adapted from the Hermes ui-tsp donor.
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Composer } from './composer.js'

export type DraftOpener = (file: string) => void | Promise<void>

/** Parse an editor command into fixed argv; quotes and backslashes are data, never a shell invocation. */
export function editorArgv(command: string): string[] {
  const args: string[] = []
  let word = ''
  let quote: "'" | '"' | null = null
  let escaped = false
  let started = false

  for (const ch of command.trim()) {
    if (escaped) {
      word += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      started = true
    } else if (quote) {
      if (ch === quote) quote = null
      else word += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (/\s/u.test(ch)) {
      if (started) args.push(word)
      word = ''
      started = false
    } else {
      word += ch
      started = true
    }
  }

  if (escaped || quote) throw new Error('Invalid VISUAL/EDITOR command: unterminated escape or quote.')
  if (started) args.push(word)
  if (!args[0]) throw new Error('VISUAL/EDITOR command is empty.')
  return args
}

/** Native Tern opens an owned file; a plain terminal yields to its configured editor. */
export const openDraftFile: DraftOpener = file => {
  const native = Boolean(process.env['TERN_WINDOW_KEY'])
  const argv = native ? ['tern', 'open', '--wait', file] : [...editorArgv(process.env['VISUAL'] || process.env['EDITOR'] || 'vi'), file]
  const raw = process.stdin.isRaw

  try {
    if (!native && process.stdin.isTTY) process.stdin.setRawMode(false)
    const binary = argv[0]
    if (!binary) throw new Error('VISUAL/EDITOR command is empty.')
    const result = spawnSync(binary, argv.slice(1), { stdio: native ? 'pipe' : 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('External editor cancelled or failed; the composer draft was kept.')
  } finally {
    if (!native && process.stdin.isTTY) process.stdin.setRawMode(Boolean(raw))
  }
}

/** A single temp file round-trip. Mode 0600; directory is private and always removed. */
export async function editTextExternal(initial: string, opener: DraftOpener = openDraftFile): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-tern-edit-'))
  try {
    const file = join(dir, 'draft.txt')
    await writeFile(file, initial, { mode: 0o600 })
    await opener(file)
    return await readFile(file, 'utf8')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface ExternalDraftHost {
  readonly composer: Pick<Composer, 'text' | 'rev' | 'set'>
  sid(): string | null
  changed(): void
  notice(text: string, tone: 'error' | 'warning'): void
  panel(title: string, text: string): void
}

const active = new WeakSet<object>()

/** Never overwrite a draft revised (even A→B→A) or a session switched during the edit. */
export async function editExternal(host: ExternalDraftHost, opener: DraftOpener = openDraftFile): Promise<void> {
  const composer = host.composer
  if (active.has(composer)) return
  const sid = host.sid()
  if (!sid) {
    host.notice('No active session to edit.', 'warning')
    return
  }
  active.add(composer)
  const rev = composer.rev
  const initial = composer.text
  try {
    const result = await editTextExternal(initial, opener)
    if (host.sid() === sid && composer.rev === rev) composer.set(result)
    else host.panel('External editor result (draft changed while editing)', result)
  } catch (error) {
    host.notice(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    active.delete(composer)
    host.changed()
  }
}
