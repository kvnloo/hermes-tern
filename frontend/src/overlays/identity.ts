// A stack-managed native node lives in one open-instance namespace. Its logical
// request key is never used as an SDK node id, including after a same-key reopen.

export const NATIVE_OVERLAY_PREFIX = 'layer.overlay-'

/** A native root's Tern child key. Never derive it from an Overlay's logical key. */
export function nativeOverlayKey(root: string): string {
  const key = root.startsWith('layer.') ? root.slice('layer.'.length) : ''

  if (!/^overlay-[1-9][0-9]*$/.test(key) || root !== `layer.${key}`) {
    throw new Error(`Expected an assigned overlay root, got ${JSON.stringify(root)}`)
  }

  return key
}

/** Exact subtree membership: overlay-1 must not own overlay-10. */
export function withinOverlayRoot(id: string, root: string): boolean {
  return id === root || id.startsWith(root + '.')
}
