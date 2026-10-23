// Real @stencil-hq/tern Session/Surface.dispatch test harness. No fake surface,
// callback shortcut, or inferred DOM events: the SDK registers and returns handlers.
import { EventEmitter } from 'node:events'

import { Session, View, type JSX, type Surface } from '@stencil-hq/tern'

type Tree = NonNullable<View['regions'][number]>

function descendants(nodes: readonly Tree[]): Tree[] {
  return nodes.flatMap(node => [node, ...descendants(node.children)])
}

export async function nativeBrowserSurface() {
  const input = new EventEmitter()
  const tern = new Session(input, { write() {} }, { exitHooks: false, record: '' })
  const connecting = tern.handshake()
  input.emit('data', `\x1b_tsp;r;${JSON.stringify({ ...tern.caps, r: 'hello', v: 1, term: 'fixture', ver: '0' })}\x1b\\`)

  if (!(await connecting)) {
    throw new Error('Native Tern SDK handshake failed')
  }

  const surface: Surface = tern.open({ id: 'hermes', mode: 'inline', role: 'omp.session', title: 'Browser test' })

  const render = (region: 'layer' | 'main', node: JSX.Element) => {
    const view = { layer: region === 'layer' ? [node] : [], main: region === 'main' ? [node] : [] }
    surface.render(view)

    return View.from(view)
  }

  const capture = (view: View, region: 'layer' | 'main', key: string, block?: string) => {
    const roots = view.regions.find(item => item?.id === region)?.children ?? []
    const match = descendants(roots).find(node => node.props.key === key && (!block || node.id.includes(`block-${block}`)))

    if (!match) {
      throw new Error(`Missing native Tern handler node: ${region}/${key}/${block ?? 'any'}`)
    }

    const action = surface.dispatch({ act: 'click', ev: 'action', id: match.id, raw: {}, sf: 'hermes' })

    if (!action) {
      throw new Error(`SDK did not register click: ${match.id}`)
    }

    return action
  }

  return { render, capture, close: () => tern.close() }
}
