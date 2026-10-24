// Child of the owned POSIX PTY harness. Real SDK handshake and real App are mandatory.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

import { connect, Node } from '@stencil-hq/tern'

import { App } from '../../app/chat.js'

import { FakeGateway } from '../fakes.js'
import { openSettings } from '../../overlays/settings.js'

const report = process.argv[2]
const mode = process.argv[3]
if (!report || mode !== 'plain') {
  throw new Error('Expected a report path and plain scenario')
}

const settingsWords: Record<string, string> = {
  'busy': 'queue',
  'approvals.mode': 'manual',
  'details_mode': 'collapsed',
  'thinking_mode': 'collapsed',
  'theme': 'auto',
  'density': 'off',
  'focus': 'off',
  'skin': 'default'
}

const gw = new FakeGateway({
  replies: {
    'setup.status': () => ({ provider_configured: true }),
    'session.create': () => ({
      info: { stored_session_id: 'pty-s1', profile_name: 'default' },
      session_id: 'pty-s1',
      subscription_id: 'sub-pty-s1'
    }),
    'config.get': params => params['key'] === 'full'
      ? { config: { display: {} } }
      : { value: settingsWords[String(params['key'])] ?? 'queue' },
    'config.set': params => {
      const field = String(params['key'])
      const value = String(params['value'])
      if (!(field in settingsWords) || params['session_id'] !== 'pty-s1' || params['profile'] !== 'default') {
        throw new Error('PTY gateway rejected an unscoped or unsupported preferences write')
      }
      settingsWords[field] = value
      return { key: field, value }
    },
    'commands.catalog': () => ({ canon: { '/ask': '/ask' }, skills: {} }),
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
const control = report + '.control'
const status = () => {
  const settings = app.overlays.find(item => item.key === 'settings')
  const node = settings?.node('layer.settings')
  const props = node instanceof Node ? node.props : undefined
  writeFileSync(report, JSON.stringify({
    calls: gw.calls,
    draft: app.stores.composer.text,
    pasted: [...app.stores.composer.pasted],
    caret: app.stores.composer.cursor,
    settingsRoot: props?.['key'],
    settingsPage: props?.['page'],
    settingsFocus: props?.['focus'],
    settingsBusy: settingsWords['busy'],
    settingsTheme: settingsWords['theme'],
    canonicalProfile: app.session.info?.profile_name,
    ready: app.session.ref.live === 'pty-s1',
    idle: app.stores.activity.busy === null,
    vim: false,
    vimMode: 'insert',
    overlays: app.overlays.map(item => item.key),
    closed
  }))
}
const running = app.run()
gw.event({ type: 'gateway.ready', payload: {} })
status()
const heartbeat = setInterval(() => {
  if (existsSync(control)) {
    const operation = readFileSync(control, 'utf8')
    unlinkSync(control)
    if (operation !== 'open-settings') throw new Error('Unknown PTY test control operation')
    // Opens the real sheet while an existing RAW SDK composer draft is held.
    // This never synthesizes an editor event or a composer submission.
    openSettings(app)
  }
  status()
}, 15)

try {
  const code = await running
  closed = true
  status()
  if (code !== 0) throw new Error('App exited with status ' + code)
} finally {
  clearInterval(heartbeat)
  status()
}
