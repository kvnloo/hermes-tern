// Native BTW sheet: history, reader and a per-thread composer. No side
// question is admitted to main transcript or the main composer history.
import type { JSX, Key, ScrollTo } from '@stencil-hq/tern'

import type { BtwThreads } from '../btw.js'
import { copyToClipboard } from '../clipboard.js'
import { actionsRow, button } from '../view/ui/button.js'

import type { Overlay } from './overlay.js'

const SCROLL: Readonly<Record<string, ScrollTo>> = {
  up: 'line-up', down: 'line-down', page_up: 'page-up', page_down: 'page-down',
  home: 'start', end: 'end'
}

type Pane = 'history' | 'reader' | 'composer'

export function openBtwOverlay(model: BtwThreads): Overlay {
  const host = model.host
  let pane: Pane = 'reader'
  let message = ''
  const valid = () => model.owns(sheet)

  const choose = (id: string | null) => {
    if (!valid()) {
      return
    }

    model.select(id)
    pane = 'composer'
    host.changed()
  }

  const move = (dir: number) => {
    const ids = model.threads.map(item => item.id)

    if (!ids.length) {
      return
    }

    const at = ids.indexOf(model.selected ?? '')
    const from = at < 0 ? (dir > 0 ? -1 : 0) : at
    const next = ids[(from + dir + ids.length) % ids.length]

    if (next) {
      choose(next)
      pane = 'history'
    }
  }

  const send = (text?: string) => {
    if (valid()) {
      void model.submit(text)
    }
  }

  const cancel = () => {
    if (valid()) {
      void model.cancel()
    }
  }

  const copy = () => {
    if (!valid()) {
      return
    }

    try {
      copyToClipboard(model.thread?.turns.map(turn => turn.question + '\n\n' + turn.answer).join('\n\n') ?? '')
      message = 'Side thread copied to the terminal clipboard.'
    } catch {
      message = 'Could not copy the side thread to the clipboard.'
    }

    host.changed()
  }

  const sheet: Overlay = {
    key: 'btw',
    modal: true,
    focus: id => pane === 'composer' ? id + '.body.followup' : null,
    cancel: () => model.close(),
    onClose: () => model.closed(sheet),
    node: (): JSX.Element => (
      <overlay anchor="bottom" head="/btw" key="btw" modal role="omp.overlay.btw" size="lg">
        <col gap="sm" key="body">
          <text key="hint" text="Tab: history / reader / composer · Ctrl+N/P: select · Alt+Enter: send · Ctrl+X: stop side turn" wrap="word" />
          <row gap="sm" key="panes" role="omp.btw.body">
            <col key="history" role="omp.btw.history">
              {button({ key: 'new', label: 'New side question', onClick: () => choose(null) })}
              {model.threads.map(thread =>
                button({
                  key: thread.id,
                  label: (thread.turns[0]?.question ?? 'Side question') + ' · ' +
                    (thread.turns.at(-1)?.state ?? 'pending') + (thread.id === model.selected ? ' · selected' : ''),
                  onClick: () => choose(thread.id)
                })
              )}
            </col>
            <col grow={1} key="reader" role="omp.btw.reader">
              {model.thread
                ? model.thread.turns.map(turn => (
                    <col gap="xs" key={turn.id} role="omp.btw.turn">
                      <md key="question" role="omp.btw.question" text={turn.question} />
                      <text key="state" role="omp.btw.meta" text={turn.state} />
                      <md key="answer" role="omp.btw.answer" stream={turn.state === 'running'} text={turn.answer || (turn.state === 'running' ? 'Waiting for answer…' : 'No answer text.')} />
                      {turn.error ? <text key="error" role="omp.btw.error" text={turn.error} wrap="word" /> : null}
                    </col>
                  ))
                : <text key="empty" text="No side question selected. Ask here or use /btw <question>." wrap="word" />}
            </col>
          </row>
          {model.state !== 'idle'
            ? <text key="pending" role="omp.btw.pending" text={model.state === 'loading' ? 'Loading side threads…' : 'Submitting side question…'} />
            : null}
          {model.error ? <text key="error" role="omp.btw.error" text={model.error} wrap="word" /> : null}
          <editor
            cursor={model.draft.cursor}
            key="followup"
            maxLines={8}
            onEdit={ev => {
              if (valid()) {
                model.draft.edit(ev)
                pane = 'composer'
                host.changed()
              }
            }}
            onSend={ev => send(ev.text)}
            onUndo={() => {
              if (valid()) {
                model.draft.undo()
                host.changed()
              }
            }}
            placeholder={model.selected ? 'Follow up in this side thread' : 'New side question'}
            sendable={model.state === 'idle' && model.thread?.turns.at(-1)?.state !== 'running'}
            text={model.draft.text}
          />
          {message ? <text key="notice" role="omp.report.notice" text={message} wrap="word" /> : null}
          {actionsRow([
            { key: 'send', label: 'Send side question', onClick: () => send() },
            ...(model.thread?.turns.at(-1)?.state === 'running'
              ? [{ key: 'cancel', label: 'Stop side turn', onClick: cancel }] : []),
            { key: 'copy', label: 'Copy', onClick: copy },
            { key: 'close', label: 'Return to main draft', hint: 'escape', onClick: () => model.close() }
          ])}
        </col>
      </overlay>
    ),
    onKey: (key: Key) => {
      if (!valid()) {
        return true
      }

      if (key.name === 'escape') {
        model.close()
      } else if (key.ctrl && key.name === 'x') {
        cancel()
      } else if (key.ctrl && key.name === 'n') {
        move(1)
      } else if (key.ctrl && key.name === 'p') {
        move(-1)
      } else if (key.name === 'tab') {
        pane = pane === 'history' ? 'reader' : pane === 'reader' ? 'composer' : 'history'
        host.changed()
      } else if (key.alt && key.name === 'enter') {
        send()
      } else if (pane === 'composer') {
        const action = model.draft.key(key)

        if (action === 'submit') {
          send()
        }

        host.changed()
      } else if (!key.ctrl && !key.alt && !key.meta && key.name === 'c') {
        copy()
      } else {
        const to = SCROLL[key.name]

        if (to) {
          host.scroll('layer.btw.body.panes.' + pane, to)
        }
      }

      return true
    }
  }

  host.open(sheet)

  return sheet
}
