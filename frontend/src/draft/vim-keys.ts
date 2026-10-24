// Vim's composer-local key table; app shortcuts and native callbacks remain separate.
import type { Key } from '@stencil-hq/tern'

/** Modal key names are deliberately scoped to the composer, never global app shortcuts. */
export const VIM_ACTIONS: ReadonlyArray<{ readonly id: string; readonly keys: readonly string[] }> = [
  { id: 'escape', keys: ['escape'] },
  { id: 'h', keys: ['h', 'left', 'backspace'] },
  { id: 'j', keys: ['j', 'down'] },
  { id: 'k', keys: ['k', 'up'] },
  { id: 'l', keys: ['l', 'right', 'space'] },
  { id: '0', keys: ['0', 'home'] },
  { id: '^', keys: ['shift+6'] },
  { id: '$', keys: ['shift+4', 'end'] },
  ...['w', 'b', 'e', 'g', 'i', 'a', 'o', 'v', 'd', 'c', 'y', 'x', 'r', 'u', 'p'].map(id => ({ id, keys: [id] })),
  ...['g', 'i', 'a', 'o', 'v', 'd', 'c', 'p'].map(id => ({ id: id.toUpperCase(), keys: [`shift+${id}`] })),
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(id => ({ id, keys: [id] })),
  { id: 'redo', keys: ['ctrl+r'] }
]

const VIM_MODIFIERS: readonly ('ctrl' | 'alt' | 'shift' | 'meta')[] = ['ctrl', 'alt', 'shift', 'meta']

export function vimActionForKey(key: Key): string | undefined {
  if ((key.text === '^' || key.text === '$') && !key.ctrl && !key.alt && !key.meta) return key.text
  return VIM_ACTIONS.find(({ keys }) => keys.some(chord => {
    const parts = chord.split('+')
    const name = parts.pop()
    return key.name.toLowerCase() === name &&
      VIM_MODIFIERS.every(mod => parts.includes(mod) === Boolean(key[mod]))
  }))?.id
}
