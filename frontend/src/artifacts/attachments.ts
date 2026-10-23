// A negotiated Tern paste/drop may carry a base64 image instead of a host path.
// Validate limits and file signatures before uploading bytes to Hermes' gateway.

import { imageFormat } from '../hermes/images.js'
import { record } from '../wire/json.js'

export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024

export interface PastedImage {
  bytes: Buffer
  mime: string
  ext: string
}

/** Accept canonical, bounded PNG/JPEG/GIF/WebP data URLs only. */
export function decodePastedImage(data: string): PastedImage {
  // Check the untrusted string before removing whitespace or allocating a byte buffer.
  if (data.length > Math.ceil(MAX_PASTED_IMAGE_BYTES * 4 / 3) + 128) {
    throw new Error('the image is larger than 20 MB')
  }

  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(data)

  if (!match?.[1] || !match[2]) {
    throw new Error('not a PNG, JPEG, GIF or WebP base64 image')
  }

  const encoded = match[2]
  if (encoded.length % 4 !== 0) {
    throw new Error('invalid base64 image')
  }

  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > MAX_PASTED_IMAGE_BYTES || bytes.toString('base64') !== encoded) {
    throw new Error('invalid or oversized base64 image')
  }

  const format = imageFormat(bytes)
  if (!format || format.mime !== match[1].toLowerCase()) {
    throw new Error('image MIME and file signature mismatch')
  }

  return { bytes, ...format }
}

/** A native Tern image event. Text paste remains the composer's own event. */
export function pastedImageEvent(value: unknown): { data: string; name: string } | undefined {
  const event = record(value)

  if (event?.['ev'] !== 'paste' && event?.['ev'] !== 'drop') {
    return undefined
  }

  const raw = record(event['raw']) ?? event
  const data = raw['data']
  const mime = raw['mime']
  const encoded = typeof data === 'string' && data.startsWith('data:image/')
    ? data
    : typeof data === 'string' && typeof mime === 'string' && /^image\/(?:png|jpeg|gif|webp)$/i.test(mime)
      ? 'data:' + mime + ';base64,' + data
      : undefined

  if (!encoded) {
    return undefined
  }

  const candidate = raw['name']
  const name = typeof candidate === 'string' && candidate.length <= 120 &&
    !Array.from(candidate).some(char => char.charCodeAt(0) < 32) && candidate.trim()
    ? candidate : 'Pasted image'

  return { data: encoded, name }
}
