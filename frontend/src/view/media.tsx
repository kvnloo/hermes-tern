// One preview control for persisted prompt images and completed tool images.
// All I/O stays behind MediaDelivery.load on an explicit click, not in rendering.
import type { JSX } from '@stencil-hq/tern'

import type { MediaDelivery, MediaPath } from '../media-delivery.js'
import { localMediaPath } from '../read-media.js'

import { button } from './ui/button.js'

/** A stored attachment path stays authoritative as a gateway-owned ref, never a Tern path. */
export function attachmentImagePath(path: string, delivery: MediaDelivery): MediaPath | undefined {
  const absolute = localMediaPath(path, undefined)
  const host = delivery.context().remoteHost

  return absolute && (host === 'frontend' || host === 'gateway')
    ? { host, id: 'attachment:' + absolute, kind: 'path', path: absolute, scope: 'attachment' }
    : undefined
}

/** The same explicit action and errors work inside a user bubble and a tool card. */
export function imagePreviewNode(source: MediaPath, delivery: MediaDelivery, alt: string, key = 'media'): JSX.Element {
  const state = delivery.preview(source)

  if (state.status === 'ready') {
    return <image alt={alt} blob={state.blob} key={key} role="omp.media.preview" />
  }

  if (state.status === 'available' || state.status === 'failed') {
    const session = delivery.deps.session()
    const token = delivery.token()

    return (
      <col gap="xs" key={key} role="omp.media.preview">
        {state.status === 'failed' ? <text key="error" role="omp.media.notice" text={state.error} wrap="word" /> : null}
        {button({
          key: 'load', label: state.label,
          onClick: () => { if (session === delivery.deps.session() && token === delivery.token()) { void delivery.load(source) } }
        })}
      </col>
    )
  }

  return <text key={key} role="omp.media.notice" text={state.label} wrap="word" />
}
