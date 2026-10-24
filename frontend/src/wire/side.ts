// Side-thread and report methods live in the plugin's registered gateway seam.
// A pinned older gateway has no such methods: do not invent side history.
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

const legacyUpdate = z.object({
  type: z.literal('btw.update'),
  session_id: z.string(),
  payload: z.object({ thread })
})

// The public scope's publish('hermes-tern.btw.update', ...) is delivered as
// a session-bound Hermes plugin.event; it is not a generated core btw.update.
const pluginUpdate = z.object({
  type: z.literal('plugin.event'),
  session_id: z.string(),
  payload: z.object({
    plugin: z.literal('hermes-tern'),
    event_name: z.literal('hermes-tern.btw.update'),
    profile: z.string(),
    data: z.object({ thread })
  })
})

const update = z.union([legacyUpdate, pluginUpdate])
const capabilities = z.object({ plugin_methods: z.array(z.string()) })

export type BtwThread = z.infer<typeof thread>

export class PluginGatewayUnavailable extends Error {
  constructor() {
    super('Needs Hermes plugin gateway methods.')
    this.name = 'PluginGatewayUnavailable'
  }
}

export function btwEvent(raw: unknown) {
  return update.safeParse(raw)
}

const METHODS = {
  list: 'hermes-tern.btw.list',
  submit: 'hermes-tern.btw.submit',
  cancel: 'hermes-tern.btw.cancel',
  report: 'hermes-tern.operations.report'
} as const

async function requireMethod(gw: Requester, sid: string, name: string): Promise<void> {
  try {
    const raw = await gw.request<unknown>('gateway.capabilities', { session_id: sid })
    const parsed = capabilities.safeParse(raw)

    if (parsed.success && parsed.data.plugin_methods.includes(name)) {
      return
    }
  } catch {
    // Older runtimes have no plugin capabilities; do not try the method.
  }

  throw new PluginGatewayUnavailable()
}

export async function listBtw(gw: Requester, sid: string): Promise<BtwThread[]> {
  await requireMethod(gw, sid, METHODS.list)
  return threads.parse(await gw.request<unknown>(METHODS.list, { session_id: sid })).threads
}

export async function submitBtw(gw: Requester, sid: string, text: string, threadId?: string) {
  await requireMethod(gw, sid, METHODS.submit)
  const result = await gw.request<unknown>(METHODS.submit, {
    session_id: sid,
    text,
    ...(threadId ? { thread_id: threadId } : {})
  })
  return submission.parse(result)
}

export async function cancelBtw(gw: Requester, sid: string, threadId: string, turnId: string) {
  await requireMethod(gw, sid, METHODS.cancel)
  const result = await gw.request<unknown>(METHODS.cancel, {
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
  await requireMethod(gw, sid, METHODS.report)
  const result = inventory.parse(await gw.request<unknown>(METHODS.report, { session_id: sid, view }))

  if (result.view !== view) {
    throw new Error('Mismatched operational view')
  }

  return result
}
