// The pinned @stencil-hq/tern 0.1.0 package predates a typed <media> builder.
// Use the public generic node builder and the SDK's negotiated "media" kind.
import { node, type Node, type Session } from '@stencil-hq/tern'

/** Wire props from stencil-hq/tern-sdk typescript/src/props.ts (MediaProps). */
export interface MediaProps {
  readonly path: string
  /** A git revision, not a tool-call revision or presentation key. */
  readonly rev?: string
  /** Synchronizes pan/zoom among media elements on Tern. */
  readonly link?: string
}

export function mediaNode(props: MediaProps, key = 'media'): Node {
  return node('media', { key, ...props })
}

/** Unknown and older peers do not receive an unadvertised node kind. */
export function hasNativeMedia(session: Pick<Session, 'caps'>): boolean {
  return Array.isArray(session.caps.kinds) && session.caps.kinds.includes('media')
}
