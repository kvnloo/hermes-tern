// Test nodes must receive an open instance's native ID, never a logical overlay key.
import { type Overlay, OverlayStack } from '../overlays/overlay.js'

/** Use the same root allocator as App; no mock native-ID aliases. */
export function assignedRoot(overlay: Overlay): string {
  const stack = new OverlayStack({
    changed: () => undefined,
    closed: () => undefined,
    opened: () => undefined
  })
  stack.open(overlay)
  return stack.rootOf(overlay)
}
