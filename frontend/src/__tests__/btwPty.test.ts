// Real OS PTY bytes feed the existing Tern-key adapter, Composer and PromptRouter.
// This exercises PTY-to-App ownership, not the native Tern SDK input parser.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Key } from '@stencil-hq/tern'
import { describe, expect, it, vi } from 'vitest'

import { App } from '../app/chat.js'

import { FakeGateway, fakeTern, given, key, settle } from './fakes.js'

vi.mock('@tui/lib/history.js', () => ({ append: () => undefined, load: () => [] }))

/** Quote a single argument in the shell command required by util-linux script -c. */
function shellQuote(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'"
}

/**
 * util-linux script(1) on Linux and BSD script(1) on Darwin each allocate
 * an actual PTY for a raw-mode Node child. Its byte acknowledgments expose
 * split UTF-8 and paste delimiters without pre-decoding the input.
 */
async function throughPty(payload: string): Promise<string> {
  const code = [
    "if (!process.stdin.isTTY) process.exit(40)",
    "process.stdin.setRawMode(true)",
    "process.stdin.resume()",
    "process.stdin.on('data', bytes => process.stdout.write('DATA ' + bytes.toString('hex') + '\\n'))",
    "process.stdout.write('READY\\n')"
  ].join('; ')
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error(`PTY acceptance requires Linux or macOS script(1), got ${process.platform}`)
  }

  // util-linux: script -q -c 'node -e ...' /dev/null
  // BSD:        script -q /dev/null node -e ...
  const args = process.platform === 'linux'
    ? ['-q', '-c', `node -e ${shellQuote(code)}`, '/dev/null']
    : ['-q', '/dev/null', 'node', '-e', code]
  const child = spawn('script', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let spawnError: Error | undefined
  let stdinError: Error | undefined
  child.once('error', error => { spawnError = error })
  child.stdin.on('error', error => { stdinError = error })
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  const assertAlive = () => {
    if (spawnError) throw new Error(`script(1) could not start: ${spawnError.message}`)
    if (stdinError) throw new Error(`PTY input write failed: ${stdinError.message}`)
    if (child.exitCode !== null) throw new Error(`script(1) exited before PTY exchange: ${child.exitCode}`)
  }
  const frames: string[] = []
  let ready = false
  let output = ''

  child.stdout.on('data', (bytes: Buffer) => {
    output += bytes.toString('utf8')
    let end: number

    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end).replace(/\r$/, '')
      output = output.slice(end + 1)

      if (line === 'READY') {
        ready = true
      } else if (line.startsWith('DATA ')) {
        frames.push(line.slice(5))
      }
    }
  })

  try {
    await vi.waitFor(() => {
      assertAlive()
      expect(ready).toBe(true)
    }, { timeout: 5000 })
    const bytes = Buffer.from(payload, 'utf8')
    // The first scalar is a four-byte emoji: split at every continuation byte.
    const writes = [
      bytes.subarray(0, 1),
      bytes.subarray(1, 2),
      bytes.subarray(2, 3),
      bytes.subarray(3, 4),
      bytes.subarray(4)
    ]
    let expectedHex = ''

    for (const part of writes) {
      expectedHex += part.toString('hex')
      child.stdin.write(part)
      await vi.waitFor(() => {
        assertAlive()
        expect(frames.join('')).toBe(expectedHex)
      }, { timeout: 5000 })
    }

    // Decode the PTY's actual receive frames incrementally, not per write.
    const utf8 = new TextDecoder('utf-8', { fatal: true })
    const received = frames.map(hex => utf8.decode(Buffer.from(hex, 'hex'), { stream: true })).join('') + utf8.decode()
    expect(received).toBe(payload)

    return received
  } finally {
    child.stdin.end()
    child.kill()
    await exited
  }
}

/** Keys in the shape delivered by the Tern SDK, fed to the app's real key dispatcher.
 * The PTY, UTF-8 decoder and paste framing are exercised above; composer editing is not mocked.
 */
function nativeKeys(input: string): Key[] {
  const keys: Key[] = []
  const begin = '\x1b[200~'
  const end = '\x1b[201~'

  for (let at = 0; at < input.length;) {
    if (input.startsWith(begin, at)) {
      const start = at + begin.length
      const close = input.indexOf(end, start)

      if (close < 0) {
        throw new Error('Unclosed bracketed paste from native PTY')
      }

      keys.push(key('paste', { text: input.slice(start, close) }))
      at = close + end.length

      continue
    }

    const scalar = input.codePointAt(at)

    if (scalar === undefined) {
      throw new Error('Incomplete Unicode scalar from native PTY')
    }

    const ch = String.fromCodePoint(scalar)
    keys.push(ch === '\r' || ch === '\n' ? key('enter') : key(ch, { text: ch }))
    at += ch.length
  }

  return keys
}

describe('BTW and main draft PTY-to-App isolation (Linux/macOS)', () => {
  it('routes split UTF-8, bracketed paste and Enter without cross-submitting', async () => {
    const previousHome = process.env['HERMES_HOME']
    const home = mkdtempSync(join(tmpdir(), 'hermes-tern-btw-pty-'))
    process.env['HERMES_HOME'] = home
    const gw = new FakeGateway({
      replies: {
        'btw.list': () => ({
          threads: [{
            id: 'prior', revision: 1,
            turns: [{ id: 't1', question: 'Old', answer: 'Old answer', state: 'answered' }]
          }]
        }),
        'btw.submit': () => ({
          thread: {
            id: 'prior', revision: 2,
            turns: [{ id: 't2', question: 'New', answer: 'Answered', state: 'answered' }]
          },
          turn_id: 't2'
        }),
        'prompt.submit': () => ({})
      }
    })
    const tern = fakeTern()
    const app = new App(tern.session, gw.client, 'test')
    const running = app.run()
    given.session(app, 's1')

    const press = async (k: Key) => {
      await vi.waitFor(() => expect(tern.reading).toBe(true))
      tern.press(k)
      await vi.waitFor(() => expect(tern.reading).toBe(true))
    }

    try {
      app.stores.composer.set('Main draft')
      await app.btw.show()
      const mainBefore = app.transcript.entries.length
      await press(key('tab')) // BTW reader -> its own composer

      const side = await throughPty('🦉\x1b[200~粘\n💡\x1b[201~\r')

      for (const k of nativeKeys(side)) {
        await press(k)
      }

      await settle(gw)
      expect(gw.sent('btw.submit')).toEqual([{
        session_id: 's1', thread_id: 'prior', text: '🦉粘\n💡'
      }])
      expect(gw.sent('prompt.submit')).toEqual([])
      expect(app.stores.composer.text).toBe('Main draft')
      expect(app.transcript.entries).toHaveLength(mainBefore)

      app.btw.close()
      expect(app.overlays).toEqual([])

      const main = await throughPty('🦊\x1b[200~x\n📎\x1b[201~\r')

      for (const k of nativeKeys(main)) {
        await press(k)
      }

      await settle(gw)
      expect(gw.sent('btw.submit')).toHaveLength(1)
      expect(gw.sent('prompt.submit')).toEqual([
        expect.objectContaining({ session_id: 's1', text: 'Main draft🦊x\n📎' })
      ])
    } finally {
      app.quit()
      tern.end()
      await running
      if (previousHome === undefined) {
        delete process.env['HERMES_HOME']
      } else {
        process.env['HERMES_HOME'] = previousHome
      }

      rmSync(home, { force: true, recursive: true })
    }
  }, 20_000)
})
