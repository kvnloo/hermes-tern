// Forward-compatible Hermes side-thread and inventory contracts. The plugin's
// pinned Hermes gateway predates these methods; reject missing or malformed
// replies instead of treating an unknown RPC response as real history.
import * as z from 'zod/mini'

import type { Requester } from './rpc.js'

const turn = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
  state: z.enum(['running', 'answered', 'error', 'cancelled']),
  error: z.optional(z.nullable(z.string()))
})

const thread = z.object({
  id: z.string(),
  revision: z.number(),
  turns: z.array(turn)
})

const threads = z.object({ threads: z.array(thread) })
const submission = z.object({ thread, turn_id: z.string() })
const update = z.object({
  type: z.literal('btw.update'),
  session_id: z.string(),
  payload: z.object({ thread })
})

export type BtwThread = z.infer<typeof thread>

export function btwEvent(raw: unknown) {
  return update.safeParse(raw)
}

export async function listBtw(gw: Requester, sid: string): Promise<BtwThread[]> {
  const result = await gw.request<unknown>('btw.list', { session_id: sid })

  return threads.parse(result).threads
}

export async function submitBtw(gw: Requester, sid: string, text: string, threadId?: string) {
  const result = await gw.request<unknown>('btw.submit', {
    session_id: sid,
    text,
    ...(threadId ? { thread_id: threadId } : {})
  })

  return submission.parse(result)
}

export async function cancelBtw(gw: Requester, sid: string, threadId: string, turnId: string) {
  const result = await gw.request<unknown>('btw.cancel', {
    session_id: sid,
    thread_id: threadId,
    turn_id: turnId
  })

  return submission.parse(result)
}

export const OPERATIONAL_VIEWS = ['mcp-list', 'mcp-status', 'mcp-tools', 'mcp-catalog', 'ssh-list'] as const

const operationalView = z.enum(OPERATIONAL_VIEWS)
const inventory = z.object({
  view: operationalView,
  scope: z.string(),
  state: z.enum(['ready', 'unavailable']),
  read_only: z.literal(true),
  rows: z.array(z.object({ name: z.string(), details: z.array(z.string()) })),
  message: z.string()
})

export type OperationalView = z.infer<typeof operationalView>
export type OperationalReport = z.infer<typeof inventory>

export async function readOperational(gw: Requester, sid: string, view: OperationalView): Promise<OperationalReport> {
  const result = inventory.parse(await gw.request<unknown>('operations.report', { session_id: sid, view }))

  // A response from another view cannot be relabeled as the requested inventory.
  if (result.view !== view) {
    throw new Error('Mismatched operational view')
  }

  return result
}
