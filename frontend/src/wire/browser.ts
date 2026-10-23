// Browser-block RPC compatibility boundary. The donor's generated contract adds these
// methods, but the plugin's pinned Hermes source predates them. Validate replies here and
// let older gateways refuse the method; never infer ownership from visible Tern panes.
import type { GatewayClient } from '@tui/gatewayClient.js'

import { record } from './json.js'

export interface BrowserBlock {
  target_id: string
  title: string
  url: string
  owner?: number | null
  owned: boolean
  available: boolean
}

export interface BrowserBlocks {
  available: boolean
  blocks: BrowserBlock[]
}

export interface BrowserTarget {
  target_id: string
  title: string
  url: string
  in_tern: true
  frame?: string
}

type Requester = Pick<GatewayClient, 'request'>
type TargetAction = 'browser.adopt' | 'browser.focus' | 'browser.frame'

/** Tern native blocks have positive decimal identifiers; no aliases or selectors. */
export function validBrowserId(id: string): boolean {
  return /^[1-9][0-9]*$/.test(id)
}

/** Exact native child-frame path, not a JavaScript expression or a URL. */
export function validBrowserFrame(frame: string): boolean {
  return frame === 'main' || /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))*$/.test(frame)
}

function blockOf(input: unknown): BrowserBlock {
  const r = record(input)
  const id = r?.['target_id']
  const title = r?.['title']
  const url = r?.['url']
  const owned = r?.['owned']
  const available = r?.['available']
  const owner = r?.['owner']

  if (
    typeof id !== 'string' || !validBrowserId(id) ||
    typeof title !== 'string' || typeof url !== 'string' ||
    typeof owned !== 'boolean' || typeof available !== 'boolean' ||
    (owner !== undefined && owner !== null && (!Number.isSafeInteger(owner) || typeof owner !== 'number'))
  ) {
    throw new Error('Invalid browser.blocks reply from Hermes')
  }

  return {
    target_id: id,
    title,
    url,
    owned,
    available,
    ...(owner === null || typeof owner === 'number' ? { owner } : {})
  }
}

/** Discovery is read-only: listing cannot grant the agent permission to drive a page. */
export async function listBrowserBlocks(gw: Requester, sessionId: string): Promise<BrowserBlocks> {
  const raw: unknown = await gw.request('browser.blocks', { session_id: sessionId })
  const data = record(raw)

  if (!data || typeof data['available'] !== 'boolean' || !Array.isArray(data['blocks'])) {
    throw new Error('Invalid browser.blocks reply from Hermes')
  }

  return { available: data['available'], blocks: data['blocks'].map(blockOf) }
}

/** The backend confirms the exact page; the frontend never selects a browser backend itself. */
export async function browserTarget(
  gw: Requester,
  action: TargetAction,
  sessionId: string,
  targetId: string,
  frame?: string
): Promise<BrowserTarget> {
  if (!validBrowserId(targetId)) {
    throw new Error('Invalid Tern browser block id')
  }

  if (action === 'browser.frame' && (!frame || !validBrowserFrame(frame))) {
    throw new Error('Use main or an exact frame index path (for example 0 or 1.0)')
  }

  const raw: unknown = await gw.request(action, {
    session_id: sessionId,
    target_id: targetId,
    ...(action === 'browser.frame' ? { frame } : {})
  })
  const data = record(raw)
  const returned = data?.['target_id']
  const title = data?.['title']
  const url = data?.['url']
  const selectedFrame = data?.['frame']

  if (
    returned !== targetId || typeof title !== 'string' || typeof url !== 'string' ||
    data?.['in_tern'] !== true ||
    (selectedFrame !== undefined && selectedFrame !== null && typeof selectedFrame !== 'string')
  ) {
    throw new Error('Invalid browser target confirmation from Hermes')
  }

  return {
    target_id: returned,
    title,
    url,
    in_tern: true,
    ...(typeof selectedFrame === 'string' ? { frame: selectedFrame } : {})
  }
}

/** Release/close is confirmed only by the authority; failed cleanup is not success. */
export async function releaseBrowserBlock(gw: Requester, sessionId: string, targetId: string): Promise<void> {
  if (!validBrowserId(targetId)) {
    throw new Error('Invalid Tern browser block id')
  }

  const raw: unknown = await gw.request('browser.release', { session_id: sessionId, target_id: targetId })
  const result = record(raw)

  if (result?.['target_id'] !== targetId || result['released'] !== true) {
    throw new Error('Hermes did not confirm browser block release')
  }
}
