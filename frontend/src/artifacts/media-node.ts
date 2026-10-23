// npm @stencil-hq/tern 0.1.0 predates the media builder. Keep only the wire
// extension here; use the SDK's generic node builder, not a fork or custom encoder.
import { node, type Node } from '@stencil-hq/tern'

// Matches MediaProps in typescript/src/props.ts and the `media` Kind in
// typescript/src/wire.ts at stencil-hq/tern-sdk f3f9fee82bf692166c2a477a895a347ac2a47ca2:
// https://github.com/stencil-hq/tern-sdk/blob/f3f9fee82bf692166c2a477a895a347ac2a47ca2/typescript/src/props.ts#L526-L534
export interface MediaProps {
  /** The file: absolute, or relative to the pane's working directory. */
  readonly path: string
  /** Read the file from git instead of disk (`HEAD`, a sha, `:0` for the index). */
  readonly rev?: string
  /** `media` nodes sharing this link pan and zoom together. */
  readonly link?: string
}

/** A caller-owned key can remount a new result; it is not a MediaProps git rev. */
export function mediaNode(props: MediaProps, key = 'media'): Node {
  return node('media', { key, ...props })
}
