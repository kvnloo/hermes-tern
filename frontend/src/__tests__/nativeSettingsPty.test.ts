// Real POSIX PTY, pinned Tern SDK and App: no fabricated editor events or direct draft mutation.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { record } from '../wire/json.js'

const exec = promisify(execFile)
const driver = fileURLToPath(new URL('./fixtures/native-settings-pty-host.py', import.meta.url))
const child = fileURLToPath(new URL('./fixtures/native-settings-pty-app.ts', import.meta.url))

const typed = 'Café 文 😀'
const pasted = '!echo should-not-run {!touch /tmp/never}\n🧩 literal 😀'

function requests(result: Record<string, unknown>, method: string): Record<string, unknown>[] {
  const calls = result['calls']
  if (!Array.isArray(calls)) throw new Error('PTY child did not report gateway calls')

  return calls.flatMap(item => {
    const call = record(item)
    if (call?.['method'] !== method) return []
    const params = record(call['params'])
    if (!params) throw new Error('PTY gateway call did not carry object params')
    return [params]
  })
}

describe('real-PTY SDK composer ownership', () => {
  it('preserves the raw SDK/App composer path after opening native Settings in plain mode', async () => {
      const { stdout } = await exec('python3', [driver, child, 'plain'], {
        cwd: process.cwd(),
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      })
      const result = record(stdout.trim())
      if (!result) throw new Error('PTY driver returned no JSON result')

      expect(result['handshake']).toBe(true)
      expect(result['opened']).toBe(true)
      expect(result['bracketed']).toBe(true)
      expect(result['frames']).toBeGreaterThan(0)
      expect(result['closed']).toBe(true)
      expect(result['vim']).toBe(false)
      expect(result['vimInsert']).toBe(false)
      expect(result['literalProvenance']).toBe(true)

      // Settings must have opened and lazily read the real owner-side allowlist.
      expect(result['settingsOpened']).toBe(true)
      expect(requests(result, 'config.get').some(p => p['key'] === 'skin')).toBe(true)
      expect(requests(result, 'config.get').some(p => p['key'] === 'full' && p['source'] === 'settings')).toBe(false)
      expect(requests(result, 'settings.get')).toEqual([])
      expect(requests(result, 'model.hub.get')).toEqual([])

      // /ask entered through the raw Tern keyboard must route to the actual slash dispatcher.
      expect(requests(result, 'slash.exec')).toEqual([
        { command: 'ask status', session_id: 'pty-s1' }
      ])

      // Separate real Enter presses submit the complete original UTF-8 and pasted payloads.
      const prompts = requests(result, 'prompt.submit')
      expect(prompts.map(p => p['text'])).toEqual([typed, pasted])
      expect(prompts.map(p => p['session_id'])).toEqual(['pty-s1', 'pty-s1'])
      expect(prompts.every(p => typeof p['submission_id'] === 'string')).toBe(true)
      expect(prompts.map(p => Object.keys(p).sort())).toEqual([
        ['session_id', 'submission_id', 'text'],
        ['session_id', 'submission_id', 'text']
      ])
      expect(prompts[0]?.['submission_id']).not.toBe(prompts[1]?.['submission_id'])

      // The pasted ! and {!...} are data, never commands for the user's shell.
      expect(requests(result, 'shell.exec')).toEqual([])
  }, 35_000)
})
