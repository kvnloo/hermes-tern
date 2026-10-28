import type { Key } from '@stencil-hq/tern'

/** Confirmation keys are intentional only when no modifier is held. */
export function unmodified(key: Key): boolean {
  return !key.ctrl && !key.alt && !key.meta && !key.shift
}

/** The usual affirmative keys for a pending yes/no confirmation. */
export function affirmative(key: Key): boolean {
  return unmodified(key) && (key.name === 'enter' || key.name === 'y')
}

/** The usual cancellation keys for a pending yes/no confirmation. */
export function negative(key: Key): boolean {
  return unmodified(key) && (key.name === 'escape' || key.name === 'n')
}
