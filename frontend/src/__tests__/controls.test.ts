// The ask_control sheet in the app: Ripple's answer vectors give the same intent through Tern's keys
// and clicks, the answer goes to the agent as the user's message, a second pane keeps the first
// pane's answer, and a resume puts each answer back on its card.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type JSX, Node } from '@stencil-hq/tern'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod/mini'

import { toolCallId } from '../core/ids.js'
import type { ToolCall } from '../model.js'
import type { Overlay } from '../overlays/overlay.js'
import { type ControlInput, type FastControl, type Intent, intentText, parseFastControl, parseIntent } from '../vendor/ripple/index.js'
import { parseJson, record } from '../wire/json.js'

import { FakeGateway, fakeTern, key, must, topNodes, tree } from './fakes.js'

const home = mkdtempSync(join(tmpdir(), 'hermes-tern-controls-'))
process.env['HERMES_HOME'] = home

vi.mock('../hermes/sessionIndex.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../hermes/sessionIndex.js')>()),
  lastReply: () => '',
  storedSessions: () => []
}))

const { App } = await import('../app/chat.js')
const { Controls } = await import('../controls/store.js')
const { Transcript } = await import('../transcript/store.js')
const { toolNode } = await import('../view/tools/shell.js')

/** Ripple's conformance vectors (vendor/ripple/vectors.json), read through a schema as any other input file. */
const Input = z.union([
  z.object({ key: z.string(), kind: z.literal('key') }),
  z.object({ id: z.string(), kind: z.literal('pick') }),
  z.object({ kind: z.literal('set'), value: z.number() }),
  z.object({ kind: z.literal('say'), text: z.string() })
])
const Vectors = z.object({
  answer: z.array(
    z.object({
      control: z.string(),
      dismiss: z.optional(z.boolean()),
      inputs: z.array(Input),
      intent: z.optional(z.nullable(z.unknown())),
      name: z.string()
    })
  ),
  controls: z.record(z.string(), z.unknown())
})

const vectors = Vectors.parse(parseJson(readFileSync(new URL('../vendor/ripple/vectors.json', import.meta.url), 'utf8')))
const controlOf = (name: string): FastControl => must(parseFastControl(vectors.controls[name]), name)
const intentOf = (raw: unknown): Intent | null => parseIntent(raw)

const flush = () => new Promise(resolve => setImmediate(resolve))

let gw: FakeGateway
let tern: ReturnType<typeof fakeTern>
let calls = 0

async function started() {
  tern = fakeTern({ draws: true })
  const app = new App(tern.session, gw.client, '')
  void app.run()
  gw.event({ payload: {}, type: 'gateway.ready' })
  await flush()
  await flush()

  return app
}

/** The tool.complete of an ask_control call showing `control`, drawn; a fresh call id each time. */
async function shown(control: unknown, id = `call_${++calls}`) {
  gw.event({
    payload: { args: control, name: 'ask_control', result: JSON.stringify({ control, note: 'End your turn now.', shown: true }), tool_id: id },
    session_id: 's1',
    type: 'tool.complete'
  })
  await flush()
  await flush()

  return id
}

/** What the app sent the agent: prompts it submitted, and those queued behind a turn. */
const told = (app: InstanceType<typeof App>) => [...gw.methods('prompt.submit').map(c => String(c.params['text'])), ...app.stores.queue.held.map(q => q.text)]

/** Every node of the overlay layer, depth first. */
function walk(nodes: readonly JSX.Element[]): Node[] {
  return nodes.flatMap(n => (n instanceof Node ? [n, ...walk(n.children)] : []))
}

/** The overlay layer's nodes with role `role`, as last drawn. */
const byRole = (role: string) => walk(topNodes(tern.region('layer'))).filter(n => n.props['role'] === role)

const top = (app: InstanceType<typeof App>) => app.stores.stack.items.at(-1)

/** `input` as Tern would send it: a key press, or an activate on the sheet's option list. */
async function send(app: InstanceType<typeof App>, id: string, input: ControlInput) {
  if (input.kind === 'key') {
    tern.press(key(input.key, input.key.length === 1 ? { text: input.key } : {}))
  } else if (input.kind === 'pick') {
    // As Tern would: the list's activate handler with the item's id (the list's own id, then the row's).
    const list = must(byRole('omp.ask.options')[0], 'the option list')
    const first = String(list.props['selected'])
    const item = `${first.slice(0, first.lastIndexOf('.'))}.${input.id}`
    list.handlers?.onActivate?.({ ev: 'activate', id: 'rows', item, raw: {}, sf: 'hermes' })
  }

  await flush()
  await flush()
}

beforeEach(() => {
  gw = new FakeGateway()
  gw.handlers.set('setup.status', () => ({ provider_configured: true }))
  gw.handlers.set('session.create', () => ({ info: { stored_session_id: 's1' }, session_id: 's1', subscription_id: 'sub1' }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('an ask_control sheet', () => {
  it('opens when the call finishes, and a number key sends the answer as the user\'s message', async () => {
    const app = await started()
    const id = await shown(vectors.controls['db'])

    expect(top(app)?.key).toBe(`control:${id}`)
    await send(app, id, { key: '2', kind: 'key' })

    expect(told(app)).toEqual(['Picked "SQLite" for: Which database should the demo use? (db = sqlite)'])
    expect(top(app)?.key).not.toBe(`control:${id}`)
    expect(must(app.transcript.call(toolCallId(id))).controlAnswer).toMatchObject({ controlId: 'db', surface: 'tern', value: 'sqlite' })

    // The claim names the chat and the call, and holds the intent.
    const claim = join(home, 'plugin-data', 'hermes-tern', 'controls', `s1.${id}.db.json`)
    expect(parseJson(readFileSync(claim, 'utf8'))).toMatchObject({ controlId: 'db', value: 'sqlite' })
  })

  for (const v of vectors.answer.filter(a => a.inputs.every(i => i.kind === 'key' || i.kind === 'pick'))) {
    it(`Ripple's vector: ${v.name}`, async () => {
      const app = await started()
      const id = await shown(vectors.controls[v.control])

      for (const input of v.inputs) {
        await send(app, id, input)
      }

      const intent = intentOf(v.intent)
      const expected = intent ? [intentText(controlOf(v.control), { ...intent, surface: 'tern' })] : []
      expect(told(app)).toEqual(expected)
      // Still open while unanswered; closed once answered or put away.
      expect(top(app)?.key === `control:${id}`).toBe(!intent && !v.dismiss)
    })
  }

  it('Esc puts it away unanswered; the card\'s Answer opens it again', async () => {
    const app = await started()
    const id = await shown(vectors.controls['ship'])

    await send(app, id, { key: 'escape', kind: 'key' })
    expect(top(app)).toBeUndefined()
    expect(told(app)).toEqual([])

    const card = JSON.stringify(tree(toolNode(must(app.transcript.call(toolCallId(id))), Date.now())))
    expect(card).toContain(`control-open=${id}`)
    expect(card).toContain('Waiting for your answer.')

    tern.send({ act: 'control-open', ev: 'action', id: 'n', sf: 'hermes', value: id })
    await flush()
    expect(top(app)?.key).toBe(`control:${id}`)

    await send(app, id, { key: 'n', kind: 'key' })
    expect(told(app)).toEqual(['Declined: Deploy now? (ship = cancel)'])

    // Answered: the card ticks the answer and offers no Answer.
    const answered = JSON.stringify(tree(toolNode(must(app.transcript.call(toolCallId(id))), Date.now())))
    expect(answered).not.toContain('control-open')
    expect(answered).toContain('✓')
  })

  it('a spoken or typed reply answers through the same model', async () => {
    const app = await started()
    const id = await shown(vectors.controls['db'])

    expect(must(app.stores.controls).hear('postgres or sqlite')).toBe(true)
    expect(told(app)).toEqual([])
    must(app.stores.controls).hear('the third one')
    expect(told(app)).toEqual(['Picked "DuckDB" for: Which database should the demo use? (db = duckdb)'])
    expect(app.stores.controls.hear('anything')).toBe(false)
    expect(top(app)?.key).not.toBe(`control:${id}`)
  })

  it('draws a slider as a meter between −/+ buttons, and the buttons move it', async () => {
    const app = await started()
    const id = await shown(vectors.controls['budget'])
    const drawn = () => JSON.stringify(tern.frame)

    expect(drawn()).toContain('"k":"meter"')
    expect(drawn()).toContain('50 ms')
    await send(app, id, { key: 'right', kind: 'key' })
    expect(drawn()).toContain('60 ms')
    const more = must(byRole('omp.btn').find(n => JSON.stringify(n.toJSON()).includes('+10')), 'the + button')
    void more.handlers?.onClick?.({ act: 'click', ev: 'action', id: 'more', raw: {}, sf: 'hermes' })
    await flush()
    expect(drawn()).toContain('70 ms')
    await send(app, id, { key: 'enter', kind: 'key' })
    expect(told(app)).toEqual(['Set 70 ms for: Latency budget? (budget = 70)'])
  })

  it('a refused control draws as the tool\'s error, with no sheet', async () => {
    const app = await started()
    gw.event({
      payload: { args: { id: 'x', kind: 'html', prompt: 'p' }, name: 'ask_control', result: JSON.stringify({ error: 'ask_control: kind must be choice, slider, confirm or candidates' }), tool_id: 'call_bad' },
      session_id: 's1',
      type: 'tool.complete'
    })
    await flush()

    expect(top(app)).toBeUndefined()
    expect(JSON.stringify(tree(toolNode(must(app.transcript.call(toolCallId('call_bad'))), Date.now())))).toContain('kind must be')
  })
})

describe('two panes on one chat', () => {
  /** A Controls on its own fake app: what it tells, and its open overlays. */
  function pane(dir: string, transcript: InstanceType<typeof Transcript>) {
    const said: string[] = []
    const open: Overlay[] = []
    const controls = new Controls(
      {
        changed: () => undefined,
        close: o => void open.splice(open.indexOf(o) >>> 0, open.includes(o) ? 1 : 0),
        open: o => void open.push(o),
        sid: () => 's9',
        tell: text => void said.push(text),
        transcript
      },
      { dir }
    )

    return { controls, open, said }
  }

  const call = (): ToolCall => ({
    args: must(record(vectors.controls['db'])),
    argsText: '',
    context: '',
    id: toolCallId('call_shared'),
    name: 'ask_control',
    outcome: { duration: 0.1, kind: 'done' },
    startedAt: 0,
    via: { kind: 'direct' }
  })

  it('the first answer is the one the agent hears; the other pane closes its sheet and shows it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-tern-claims-'))
    const a = pane(dir, new Transcript())
    const b = pane(dir, new Transcript())
    const ca = call()
    const cb = call()

    a.controls.show(ca)
    b.controls.show(cb)
    expect([a.open.length, b.open.length]).toEqual([1, 1])

    must(a.open[0]).onKey(key('1', { text: '1' }))
    must(b.open[0]).onKey(key('3', { text: '3' }))

    expect(a.said).toEqual(['Picked "Postgres" for: Which database should the demo use? (db = postgres)'])
    expect(b.said).toEqual([])
    expect(cb.controlAnswer).toMatchObject({ value: 'postgres' })
    expect([a.open.length, b.open.length]).toEqual([0, 0])
    expect(existsSync(join(dir, 'controls', 's9.call_shared.db.json'))).toBe(true)

    // A resumed pane reads the answer back: no sheet opens for an answered control.
    const c = pane(dir, new Transcript())
    const cc = call()
    c.controls.show(cc)
    expect(c.open).toEqual([])
    expect(cc.controlAnswer).toMatchObject({ value: 'postgres' })
  })
})
