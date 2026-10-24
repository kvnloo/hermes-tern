// The durable fork method lives in newer Hermes gateways, but not in the version this plugin
// currently pins. Keep the untyped request and its checked reply at the wire boundary.

import type { Requester } from './rpc.js'

export interface DurableFork {
  sessionId: string
  profile: string
}

/** An older gateway can report an absent method as JSON-RPC -32601 or a text error. */
export function isUnsupportedFork(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === -32601) {
    return true
  }

  const message = error instanceof Error ? error.message : String(error)

  return /method not found|unknown method|no such method|unsupported method|unrecognized method/i.test(message)
}

/** Never treat an unverified fork reply as a saved child. */
export async function requestDurableFork(gw: Requester, sid: string, targetMessageId?: number): Promise<DurableFork> {
  const reply: unknown = await gw.request<unknown>('session.fork', {
    session_id: sid,
    ...(targetMessageId === undefined ? {} : { target_message_id: targetMessageId })
  })

  if (
    typeof reply !== 'object' ||
    reply === null ||
    !('session_id' in reply) ||
    typeof reply.session_id !== 'string' ||
    !reply.session_id.trim() ||
    !('profile' in reply) ||
    typeof reply.profile !== 'string' ||
    !reply.profile.trim()
  ) {
    throw new Error('session.fork did not return a saved child id and its owning profile')
  }

  return { profile: reply.profile, sessionId: reply.session_id }
}
