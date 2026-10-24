// Browser result presentation stays in the existing registry/card architecture.
// The card offers Focus only from a confirmed result; the current session and the gateway
// remain authoritative. Stale transcript actions never hand over or select by title/URL.
import type { JSX } from '@stencil-hq/tern'

import type { ChatPorts } from '../../../app/ports.js'
import { errorText } from '../../../core/errors.js'
import type { SessionIds } from '../../../core/ids.js'
import type { ToolCall } from '../../../model.js'
import { type TernTarget, ternTargetOf } from '../../../tools/browser.js'
import { button } from '../../ui/button.js'
import { browserCaller, browserTarget } from '../../../wire/browser.js'

import type { Card } from '../types.js'

export function browserBlockCard(card: Card, call: ToolCall): Card {
  const target = ternTargetOf(call)

  if (!target) {
    return card
  }

  const meta = [
    ...(card.meta ?? []),
    ...(target.title ? [target.title] : []),
    `in Tern block ${target.target_id}`,
    ...(target.frame ? [`evaluation frame ${target.frame}`] : [])
  ]

  return {
    ...card,
    target: target.url || card.target,
    targetKind: 'path',
    meta: [...new Set(meta)],
    folded: false
  }
}

/** Native Focus is an intent for exactly the identity in this result, not its title or URL. */
export type BrowserFocus = (call: ToolCall, target: TernTarget) => void

/** The only live app ports a Focus intent may read. */
export type BrowserFocusHost = Pick<ChatPorts, 'gw' | 'notice' | 'session' | 'transcript'>

/**
 * Bind a rendered transcript to its actual session instance. A reattach, session
 * switch, reset, removed call, or edited result revokes old SDK callbacks.
 * The gateway's browser.focus operation validates ownership and confirms the id;
 * no local metadata can grant ownership or cause an implicit browser.adopt.
 */
export function bindBrowserFocus(host: BrowserFocusHost, source: Pick<SessionIds, 'live'>): BrowserFocus | undefined {
  const sid = source.live

  if (!sid) {
    return undefined
  }

  const caller = browserCaller(host.session)
  if (!caller || !caller.current()) {
    return undefined
  }

  const live = () => host.session.ref === source && host.session.ref.live === sid && caller.current()

  return (call, target) => {
    if (!live() || call.outcome.kind !== 'done' ||
      !host.transcript.entries.some(entry => entry.kind === 'turn' &&
        entry.blocks.some(block => block.kind === 'tool' && block.call === call))) {
      return
    }

    const original = ternTargetOf(call)

    if (!original || original.target_id !== target.target_id || original.title !== target.title ||
      original.url !== target.url || original.frame !== target.frame) {
      return
    }

    void browserTarget(host.gw, 'hermes-tern.browser.focus', caller, target.target_id).catch(error => {
      if (live()) {
        host.notice(errorText(error), 'warning')
      }
    })
  }
}

/** An SDK button, not an inferred browser permission or a second backend method. */
export function browserFocusButton(call: ToolCall, focus: BrowserFocus | undefined): JSX.Element | undefined {
  const target = ternTargetOf(call)

  if (!focus || !target || call.outcome.kind !== 'done') {
    return undefined
  }

  return button({
    key: 'browser-focus',
    label: `Focus Tern block ${target.target_id}`,
    onClick: () => focus(call, target)
  })
}
