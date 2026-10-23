// Native browser-block sheet, ported from ui-tsp's explicit-intent browser adapter.
// No polling, no alternate browser backend, no ownership store in the frontend.
import type { Key } from '@stencil-hq/tern'

import type { ChatPorts } from '../app/ports.js'
import { errorText } from '../core/errors.js'
import { Composer } from '../draft/composer.js'
import { actionsRow, button } from '../view/ui/button.js'
import { type BrowserBlock, browserTarget, listBrowserBlocks, releaseBrowserBlock } from '../wire/browser.js'

import type { Overlay } from './overlay.js'
import { moveSelection } from './search.js'

export type BrowserHost = Pick<ChatPorts, 'busy' | 'changed' | 'close' | 'gw' | 'open' | 'overlays' | 'session'>

const KEY = 'browser-blocks'

export function openBrowserBlocks(host: BrowserHost): void {
  const sessionRef = host.session.ref
  const sid = sessionRef.live

  if (!sid) {
    return
  }

  let blocks: BrowserBlock[] = []
  let available = false
  let loading = false
  let working = false
  let message = 'Loading Tern browser blocks…'
  let selected: string | undefined
  let editing: string | undefined
  const frame = new Composer()
  frame.set('main')

  // Closing, replacement, or a switched session invalidates all late answers.
  const live = () => host.session.ref === sessionRef && host.session.ref.live === sid && host.overlays.at(-1) === overlay

  const refresh = async () => {
    if (!live() || working || loading) {
      return
    }

    loading = true
    host.changed()

    try {
      const result = await listBrowserBlocks(host.gw, sid)

      if (!live()) {
        return
      }

      blocks = result.blocks
      available = result.available
      selected = blocks.some(block => block.target_id === selected) ? selected : blocks[0]?.target_id
      message = !available
        ? 'Tern browser interface unavailable. The existing browser backend is unchanged.'
        : blocks.length
          ? ''
          : 'No browser blocks. Hermes creates an agent-owned block on first native navigation.'
    } catch (error) {
      if (!live()) {
        return
      }

      const detail = errorText(error)
      message = /method not found|unknown method|no such method/i.test(detail)
        ? 'This Hermes gateway does not support browser-block controls. Use a gateway with the ui-tsp browser RPC contract.'
        : detail
      available = false
      blocks = []
      selected = undefined
    } finally {
      if (live()) {
        loading = false
        host.changed()
      }
    }
  }

  const current = () => blocks.find(block => block.target_id === selected)
  // A rendered handler owns this exact listing instance. A refresh revokes old handlers,
  // even when the native target id is reused; selection alone never redirects an intent.
  const present = (block: BrowserBlock) => blocks.find(item => item.target_id === block.target_id) === block
  const mayChoose = (block: BrowserBlock) => available && !working && !loading &&
    (block.owned || (block.available && !host.busy))
  const mayModify = (block: BrowserBlock) => available && block.owned && !working && !loading && !host.busy

  /** Pointer actions capture a rendered block; keyboard actions resolve a live block at the key press. */
  const choose = async (block: BrowserBlock | undefined, intent: 'use' | 'release' | 'frame') => {
    if (!live() || !block || !present(block) || !available || working ||
      (intent === 'frame' && editing !== block.target_id) ||
      (intent === 'use' ? !mayChoose(block) : !mayModify(block))) {
      return
    }

    working = true
    host.changed()

    try {
      if (intent === 'release') {
        await releaseBrowserBlock(host.gw, sid, block.target_id)

        if (live()) {
          if (editing === block.target_id) {
            editing = undefined
          }

          working = false
          await refresh()
        }
      } else if (intent === 'frame') {
        const result = await browserTarget(host.gw, 'browser.frame', sid, block.target_id, frame.text.trim())

        if (live()) {
          message = `Block ${result.target_id} · evaluation frame ${result.frame ?? 'main'}`
          if (editing === block.target_id) {
            editing = undefined
          }
        }
      } else {
        await browserTarget(host.gw, block.owned ? 'browser.focus' : 'browser.adopt', sid, block.target_id)

        if (live()) {
          host.close(overlay)
        }
      }
    } catch (error) {
      if (live()) {
        message = errorText(error)
      }
    } finally {
      if (live()) {
        working = false
        host.changed()
      }
    }
  }

  const beginFrame = (block: BrowserBlock) => {
    if (!live() || !present(block) || !mayModify(block)) {
      return
    }

    editing = block.target_id
    frame.set('main')
    host.changed()
  }

  const overlay: Overlay = {
    key: KEY,
    modal: true,
    focus: id => editing ? `${id}.body.block-${editing}.frame-form.frame-path` : null,
    node: () => (
      <overlay anchor="center" head="Tern browser blocks" key={KEY} modal role="omp.overlay.browser" size="lg">
        <col gap="sm" key="body">
          <text key="intro" text="Discovery does not grant control. Hand over an undriven block explicitly; Focus only targets blocks Hermes owns." wrap="word" />
          <text key="limits" text="Release keeps adopted pages and closes agent-created pages. Child frames allow evaluation only. Recording, console buffering and annotated captures are unavailable." wrap="word" />
          {message ? <text key="message" text={message} wrap="word" /> : null}
          {blocks.map(block => (
            <col gap="sm" key={`block-${block.target_id}`}>
              <row
                gap="sm"
                key="identity"
                onClick={() => {
                  if (!working && !loading) {
                    selected = block.target_id
                    host.changed()
                  }
                }}
                role="omp.browser.block"
              >
                <icon key="mark" name={selected === block.target_id ? 'chevron-right' : 'globe'} />
                <text key="label" text={`${block.target_id} · ${block.title} · ${block.url} · owner ${block.owner ?? 'docked'}`} wrap="word" />
              </row>
              {selected === block.target_id ? (
                <col gap="sm" key="selection">
                  <row gap="sm" key="buttons" wrap>
                    {mayChoose(block)
                      ? button({
                          key: 'choose',
                          label: working ? 'Working…' : block.owned ? 'Focus' : 'Hand over to agent',
                          hint: 'enter',
                          onClick: () => void choose(block, 'use')
                        })
                      : <text key="unavailable" text={block.owned ? 'Busy' : !block.available ? 'Unavailable / already driven' : 'Wait for turn to finish'} />}
                    {mayModify(block)
                      ? [
                          button({ key: 'release', label: 'Release / close owned block', hint: 'r', onClick: () => void choose(block, 'release') }),
                          button({ key: 'frame', label: 'Evaluation frame…', hint: 'f', onClick: () => beginFrame(block) })
                        ]
                      : null}
                  </row>
                </col>
              ) : null}
              {editing === block.target_id ? (
                <col gap="sm" key="frame-form">
                  <text key="help" text="Select main or an exact native index path (0, 1.0). Hermes verifies it before selection." wrap="word" />
                  <input
                    aria="Evaluation frame path"
                    cursor={frame.cursor}
                    key="frame-path"
                    onEdit={ev => {
                      if (live() && present(block) && editing === block.target_id && !working) {
                        frame.edit(ev)
                        host.changed()
                      }
                    }}
                    role="omp.ask.input"
                    text={frame.text}
                  />
                  {actionsRow([
                    { key: 'apply-frame', label: 'Verify and select frame', onClick: () => void choose(block, 'frame') },
                    { key: 'cancel-frame', label: 'Cancel', onClick: () => { if (live() && present(block) && editing === block.target_id && !working) { editing = undefined; host.changed() } } }
                  ])}
                </col>
              ) : null}
            </col>
          ))}
          {actionsRow([
            { key: 'refresh', label: loading ? 'Loading…' : 'Refresh', hint: 'shift+r', onClick: () => void refresh() },
            { key: 'close', label: 'Close', hint: 'escape', onClick: () => host.close(overlay) }
          ])}
        </col>
      </overlay>
    ),
    onKey: (key: Key) => {
      if (editing) {
        if (key.name === 'escape') {
          editing = undefined
        } else if (key.name === 'up' || key.name === 'down') {
          // Moving the keyboard selection leaves the frame form bound to its original block.
          selected = moveSelection(key, blocks.map(block => block.target_id), selected) ?? selected
        } else if (frame.key(key) === 'submit') {
          void choose(blocks.find(block => block.target_id === editing), 'frame')
        }

        host.changed()

        return true
      }

      if (key.name === 'escape') {
        host.close(overlay)
      } else if (key.name === 'r' && key.shift) {
        void refresh()
      } else if (key.name === 'enter') {
        void choose(current(), 'use')
      } else if (key.name === 'r' && !key.ctrl && !key.alt && !key.meta) {
        void choose(current(), 'release')
      } else if (key.name === 'f' && !key.ctrl && !key.alt && !key.meta) {
        const block = current()
        if (block) {
          beginFrame(block)
        }
      } else {
        selected = moveSelection(key, blocks.map(block => block.target_id), selected) ?? selected
      }

      host.changed()

      return true
    }
  }

  host.open(overlay)
  void refresh()
}
