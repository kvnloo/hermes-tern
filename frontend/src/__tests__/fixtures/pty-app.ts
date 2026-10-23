// Child of the owned POSIX PTY harness. Real SDK handshake and real App are mandatory.
import { writeFileSync } from 'node:fs'

import { connect } from '@stencil-hq/tern'

import { App } from '../../app/chat.js'

import { FakeGateway } from '../fakes.js'

const report = process.argv[2]
const mode = process.argv[3]
if (!report || (mode !== 'plain' && mode !== 'vim')) {
  throw new Error('Expected a report path and plain|vim scenario')
}

const gw = new FakeGateway({
  replies: {
    'setup.status': () => ({ provider_configured: true }),
    'session.create': () => ({
      info: { stored_session_id: 'pty-s1' },
      session_id: 'pty-s1',
      subscription_id: 'sub-pty-s1'
    }),
    'config.get': params => params['key'] === 'full'
      ? { config: { display: { vim_mode: mode === 'vim' } } }
      : { value: 'queue' },
    'commands.catalog': () => ({ canon: {}, skills: {} }),
    'slash.exec': () => ({ output: 'Command received' })
  }
})

// This is a gateway completion, not a synthetic Tern editor/send event. The prompt itself
// must have traversed the SDK's raw key parser, App, key rules and PromptRouter.
gw.handlers.set('prompt.submit', () => {
  queueMicrotask(() => gw.event({
    type: 'message.complete',
    session_id: 'pty-s1',
    payload: { text: 'completed' }
  }))
  return { status: 'started' }
})

const tern = await connect({
  app: 'hermes',
  features: ['edit', 'undo', 'send'],
  version: 'pty-acceptance'
})
if (!tern) throw new Error('Pinned Tern SDK did not complete the real PTY handshake')

const app = new App(tern, gw.client, 'pty-acceptance')
let closed = false
const status = () => writeFileSync(report, JSON.stringify({
  calls: gw.calls,
  ready: app.session.ref.live === 'pty-s1',
  idle: app.stores.activity.busy === null,
  vim: app.stores.composer.vim.enabled,
  vimMode: app.stores.composer.vim.mode,
  closed
}))
const running = app.run()
gw.event({ type: 'gateway.ready', payload: {} })
status()
const heartbeat = setInterval(status, 15)

try {
  const code = await running
  closed = true
  status()
  if (code !== 0) throw new Error('App exited with status ' + code)
} finally {
  clearInterval(heartbeat)
  status()
}
