// Browser result presentation stays in the existing registry/card architecture.
// The sheet owns interactive focus: a transcript result is not proof of live ownership.
import type { ToolCall } from '../../../model.js'
import { ternTargetOf } from '../../../tools/browser.js'

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
