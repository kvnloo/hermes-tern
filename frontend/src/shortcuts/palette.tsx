// Native Tern command palette. Selection reuses the exact slash dispatcher;
// composing / completion and gateway authority remain unchanged.

import type { CommandsCatalogResult } from '@hermes/shared/gateway-events'
import type { Key, PickerItem } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { HIDDEN_COMMANDS, localCommands } from '../commands/local.js'
import type { Composer } from '../draft/composer.js'
import { editQuery, hitRuns, moveSelection, rank } from '../overlays/search.js'
import type { Overlay } from '../overlays/overlay.js'
import { rpc } from '../wire/rpc.js'

export type PaletteHost = Pick<ChatPorts, 'changed' | 'close' | 'gw' | 'open' | 'session' | 'transcript'> & {
  readonly composer: Pick<Composer, 'set'>
  run(command: string): void
}

export interface PaletteRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly group: string
}

/** Merge frontend-owned and gateway commands without duplicating aliases. */
export function paletteRows(catalog: CommandsCatalogResult = {}): PaletteRow[] {
  const rows: PaletteRow[] = []
  const seen = new Set<string>()

  const add = (raw: string, description: string, group: string) => {
    const name = /^\/?[a-z][\w-]*/i.exec(raw.trim())?.[0]?.replace(/^\//, '').toLowerCase()

    if (!name || HIDDEN_COMMANDS.has(name) || seen.has(name)) {
      return
    }

    seen.add(name)
    rows.push({ id: `/${name}`, name: `/${name}`, description, group })
  }

  for (const c of localCommands()) {
    add(c.name, c.help ?? 'Hermes command', 'Tern / Hermes')
  }

  for (const category of catalog.categories ?? [{ name: 'Commands', pairs: catalog.pairs ?? [] }]) {
    for (const [raw = '', description = ''] of category.pairs ?? []) {
      add(raw, description.replace(/\s*\(usage: .+\)\s*$/, ''), category.name)
    }
  }

  return rows
}

/** Command search keeps draft/caret intact until explicit Insert or Run. */
export function openCommandPalette(host: PaletteHost): void {
  const sid = host.session.ref.live
  const KEY = 'command-palette'
  let alive = true
  let state: 'loading' | 'ready' | 'error' = 'loading'
  let message = ''
  let all = paletteRows()
  let query = ''
  let selected = all[0]?.id
  let shown = all.map(row => row.id)

  const view = () => {
    const ranked = rank(all, query, row => `${row.name} ${row.description} ${row.group}`)
    const hits: Record<string, [number, number][]> = {}

    shown = ranked.map(row => row.item.id)
    for (const row of ranked) {
      if (row.positions.length) {
        hits[row.item.id] = hitRuns(row.positions, row.item.name.length)
      }
    }

    if (!selected || !shown.includes(selected)) {
      selected = shown[0]
    }

    return { hits, order: [...shown] }
  }

  const current = (id = selected) => all.find(row => row.id === id)
  const pick = (id: string | undefined, execute: boolean) => {
    const command = current(id)?.name

    if (!command || !alive || sid !== host.session.ref.live) {
      return
    }

    host.close(overlay)

    if (execute) {
      host.run(command)
    } else {
      host.composer.set(`${command} `, { literal: true })
      host.changed()
    }
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    onClose: () => { alive = false },
    node: () => {
      const { hits, order } = view()
      const items: PickerItem[] = all.map(row => ({
        detail: row.description,
        id: row.id,
        label: row.name,
        mono: true,
        title: `${row.group} · ${row.description}`
      }))

      return (
        <picker
          actions={[
            { id: 'insert', keys: ['tab'], label: 'Insert in draft' },
            { end: true, id: 'close', keys: ['esc'], label: 'Close' },
            { id: 'run', keys: ['enter'], label: 'Run', primary: true }
          ]}
          empty="No matching commands"
          hits={hits}
          icon="command"
          items={items}
          key={KEY}
          noun="commands"
          onAction={{
            clear: () => { query = ''; host.changed() },
            close: () => host.close(overlay),
            insert: () => pick(selected, false),
            run: () => pick(selected, true),
            retry: () => void load()
          }}
          onActivate={ev => pick(ev.item, true)}
          onSelect={ev => { selected = ev.item; host.changed() }}
          order={order}
          placeholder="Search Hermes commands…"
          query={query}
          {...(selected ? { selected } : {})}
          size="lg"
          state={state}
          {...(message ? { message } : {})}
          title="Command palette"
          total={all.length}
        />
      )
    },
    onKey: (key: Key) => {
      if (key.name === 'escape') {
        host.close(overlay)
      } else if (key.name === 'enter') {
        pick(selected, true)
      } else if (key.name === 'tab') {
        pick(selected, false)
      } else {
        const moved = moveSelection(key, shown, selected)

        if (moved !== undefined) {
          selected = moved
        } else {
          const edited = editQuery(key, query)

          if (edited !== undefined) {
            query = edited
          }
        }
      }

      return true
    }
  }

  const load = async () => {
    if (!sid) {
      state = 'ready'

      return host.changed()
    }

    try {
      const catalog = await rpc(host.gw, 'commands.catalog', { session_id: sid })

      if (!alive || sid !== host.session.ref.live) {
        return
      }

      all = paletteRows(catalog)
      selected = all[0]?.id
      state = 'ready'
    } catch (error) {
      if (!alive || sid !== host.session.ref.live) {
        return
      }

      state = 'error'
      message = error instanceof Error ? error.message : String(error)
      host.transcript.notice(`Command catalog unavailable: ${message}`, 'warning')
    }

    host.changed()
  }

  host.open(overlay)
  void load()
}
