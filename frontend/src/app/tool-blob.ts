import type { Session } from '@stencil-hq/tern'

/** Offer bytes only through the owning SDK transport and its negotiated blob limit. */
export function toolBlob(tern: Pick<Session, 'caps' | 'blob'>, bytes: Uint8Array, mime: string): string | undefined {
  if (!tern.caps.features.includes('blobs')) return undefined
  try {
    return tern.blob(bytes, mime)
  } catch {
    return undefined
  }
}
