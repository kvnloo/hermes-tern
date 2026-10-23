// Modal composer editing inspired by oh-my-pi (Can Bölük / Stencil), MIT.
// Composer remains the sole owner of text and undo; this owns only modal state.
import type { Key } from '@stencil-hq/tern'

import type { Composer } from './composer.js'

export type VimMode = 'insert' | 'normal' | 'visual' | 'visual-line'
type Operator = 'd' | 'c' | 'y'
interface Motion {
  to: number
  inclusive?: boolean
  linewise?: boolean
}
interface Range {
  from: number
  to: number
  linewise?: boolean
}

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const wordClass = (text: string) => (/\s/u.test(text) ? 0 : /[\p{L}\p{N}_]/u.test(text) ? 1 : 2)
const MAX_COUNT = 10000

export class VimComposer {
  enabled = false
  mode: VimMode = 'insert'
  anchor: number | undefined
  #count = ''
  #operator: Operator | undefined
  #operatorCount = 1
  #prefix = ''
  #register = ''
  #linewise = false
  #column: number | undefined

  constructor(private readonly composer: Composer) {}

  get pending(): string {
    return `${this.#operator ?? ''}${this.#count}${this.#prefix}`
  }
  get visual(): boolean {
    return this.mode === 'visual' || this.mode === 'visual-line'
  }
  get nativeMode(): string | undefined {
    return this.enabled ? this.mode : undefined
  }
  get selection(): { cursor: number; anchor?: number } {
    const { cursor } = this.composer

    if (!this.visual || this.anchor === undefined) {
      return { cursor }
    }

    const range = this.#range()

    return cursor >= this.anchor ? { anchor: range.from, cursor: range.to } : { anchor: range.to, cursor: range.from }
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) {
      return
    }

    this.enabled = enabled
    // Native selection cannot remain hidden under Vim's independent Visual anchor.
    this.composer.move(this.composer.cursor)
    this.reset()
  }

  reset() {
    this.#clear()
    this.anchor = undefined
    this.mode = 'insert'
    this.#column = undefined
    this.composer.undoBoundary()
  }

  /** Called before app actions, but only after overlays and completion. Quiet Normal Escape falls through. */
  key(key: Key): boolean {
    if (!this.enabled) {
      return false
    }

    const action = vimActionForKey(key)

    if (action === 'escape') {
      if (this.pending) {
        this.#clear()

        return true
      }

      if (this.mode === 'normal') {
        return false
      }

      if (this.mode === 'insert') {
        this.composer.move(
          Math.max(
            lineStart(this.composer.text, this.composer.cursor),
            prevGrapheme(this.composer.text, this.composer.cursor)
          )
        )
      }

      this.#mode('normal')

      return true
    }

    // Paste is literal, atomic text in every mode, never a sequence of Vim commands.
    if (key.name === 'paste') {
      this.#clear()
      const range = this.visual ? this.#range() : { from: this.composer.cursor, to: this.composer.cursor }
      this.composer.paste(key.text ?? '', range.from, range.to)

      if (this.mode !== 'insert') {
        this.#mode('normal')
        this.#clamp()
      }

      return true
    }

    if (this.mode === 'insert') {
      return false
    }

    if (this.#prefix === 'r' && key.text && !key.ctrl && !key.meta && !key.alt) {
      this.#replace(key.text)

      return true
    }

    if (!action) {
      // Keep app shortcuts and Enter available; unknown printable input must not leak into the draft.
      if (key.text && !key.ctrl && !key.meta && !key.alt) {
        this.#clear()

        return true
      }

      return false
    }

    if (/^[0-9]$/.test(action) && (action !== '0' || this.#count)) {
      this.#count = String(Math.min(MAX_COUNT, Number(this.#count + action)))

      return true
    }

    const count = Math.min(MAX_COUNT, Math.max(1, Number(this.#count || 1)) * this.#operatorCount)

    if (this.#prefix === 'g') {
      this.#prefix = ''

      if (action === 'g') {
        this.#motion({ to: this.#line(count - 1), linewise: true })
      }

      this.#clear()

      return true
    }

    const motion = this.#motions(count)[action]

    if (motion) {
      if (action !== 'j' && action !== 'k') {
        this.#column = undefined
      }

      this.#motion(motion())
      this.#clear()

      return true
    }

    if (this.#operator && action !== this.#operator && action !== 'g') {
      this.#clear()

      return true
    }

    this.#column = undefined
    const handler = this.#commands(count)[action]

    if (handler) {
      handler()
    } else {
      this.#clear()
    }

    return true
  }

  #clear() {
    this.#count = ''
    this.#operator = undefined
    this.#operatorCount = 1
    this.#prefix = ''
  }
  #mode(mode: VimMode) {
    this.composer.undoBoundary()
    this.mode = mode

    if (!this.visual) {
      this.anchor = undefined
    }

    this.#clear()

    if (mode === 'normal') {
      this.#clamp()
    }
  }
  #clamp() {
    const { text, cursor } = this.composer
    const start = lineStart(text, cursor)
    const end = lineEnd(text, cursor)
    this.composer.move(end > start ? Math.min(cursor, prevGrapheme(text, end)) : start)
  }
  #line(n: number): number {
    const lines = this.composer.text.split('\n')

    return lines.slice(0, Math.max(0, Math.min(n, lines.length - 1))).reduce((sum, line) => sum + line.length + 1, 0)
  }
  #vertical(delta: number): number {
    const { text, cursor } = this.composer
    const start = lineStart(text, cursor)
    const line = text.slice(0, start).split('\n').length - 1
    this.#column ??= [...segments.segment(text.slice(start, cursor))].length
    const target = this.#line(line + delta)
    const graphemes = [...segments.segment(text.slice(target, lineEnd(text, target)))]

    return target + (graphemes[this.#column]?.index ?? lineEnd(text, target) - target)
  }
  #step(at: number, count: number, dir: -1 | 1): number {
    const { text } = this.composer

    const boundaries = [...segments.segment(text)].map(part => part.index)
    boundaries.push(text.length)
    const index = Math.max(0, boundaries.indexOf(at))

    return boundaries[Math.max(0, Math.min(boundaries.length - 1, index + dir * count))] ?? 0
  }
  #word(at: number, dir: -1 | 1, end = false): number {
    const { text } = this.composer

    if (dir < 0) {
      at = prevGrapheme(text, at)

      while (at > 0 && wordClass(text.slice(at, nextGrapheme(text, at))) === 0) {
        at = prevGrapheme(text, at)
      }

      const cls = wordClass(text.slice(at, nextGrapheme(text, at)))

      while (at > 0 && wordClass(text.slice(prevGrapheme(text, at), at)) === cls) {
        at = prevGrapheme(text, at)
      }

      return at
    }

    if (end) {
      at = nextGrapheme(text, at)
    }

    const cls = wordClass(text.slice(at, nextGrapheme(text, at)))

    if (!end) {
      while (at < text.length && wordClass(text.slice(at, nextGrapheme(text, at))) === cls) {
        at = nextGrapheme(text, at)
      }
    }

    while (at < text.length && wordClass(text.slice(at, nextGrapheme(text, at))) === 0) {
      at = nextGrapheme(text, at)
    }

    if (end) {
      const target = wordClass(text.slice(at, nextGrapheme(text, at)))

      while (at < text.length && wordClass(text.slice(at, nextGrapheme(text, at))) === target) {
        at = nextGrapheme(text, at)
      }

      at = prevGrapheme(text, at)
    }

    return at
  }
  #motions(count: number): Record<string, () => Motion> {
    const { text, cursor } = this.composer

    const word = (dir: -1 | 1, end = false) => {
      let to = cursor

      for (let i = 0; i < count; i++) {
        to = this.#word(to, dir, end)
      }

      return { to, inclusive: end }
    }

    return {
      h: () => ({ to: Math.max(lineStart(text, cursor), this.#step(cursor, count, -1)) }),
      l: () => ({ to: Math.min(lineEnd(text, cursor), this.#step(cursor, count, 1)) }),
      j: () => ({ to: this.#vertical(count), linewise: true }),
      k: () => ({ to: this.#vertical(-count), linewise: true }),
      '0': () => ({ to: lineStart(text, cursor) }),
      '^': () => ({
        to:
          lineStart(text, cursor) +
          (text.slice(lineStart(text, cursor)).match(/^\s*/u)?.[0].replace(/\n.*$/s, '').length ?? 0)
      }),
      $: () => ({ to: lineEnd(text, cursor), inclusive: true }),
      w: () =>
        this.#operator === 'c' && wordClass(text.slice(cursor, nextGrapheme(text, cursor))) !== 0
          ? this.#changeWord(count)
          : word(1),
      b: () => word(-1),
      e: () => word(1, true),
      G: () => ({ to: this.#count ? this.#line(count - 1) : this.#line(text.split('\n').length - 1), linewise: true })
    }
  }
  #changeWord(count: number): Motion {
    const { text, cursor } = this.composer
    let to = cursor

    for (let n = 0; n < count; n++) {
      if (n > 0) {
        to = this.#word(to, 1)
      }

      const cls = wordClass(text.slice(to, nextGrapheme(text, to)))

      while (to < text.length && wordClass(text.slice(to, nextGrapheme(text, to))) === cls) {
        to = nextGrapheme(text, to)
      }
    }

    return { to }
  }
  #motion(motion: Motion) {
    const { text, cursor } = this.composer
    const operator = this.#operator

    if (!operator) {
      this.composer.move(motion.to)
      if (!this.visual) this.#clamp()

      return
    }

    let from = Math.min(cursor, motion.to)
    let to = Math.max(cursor, motion.to)

    if (motion.linewise) {
      from = lineStart(text, from)
      to = lineEnd(text, to)
    } else if (motion.inclusive && to < lineEnd(text, to)) {
      to = nextGrapheme(text, to)
    }

    this.#operate(operator, { from, to, linewise: motion.linewise })
  }
  #range(): Range {
    const { text, cursor } = this.composer
    let from = Math.min(this.anchor ?? cursor, cursor)
    let to = Math.max(this.anchor ?? cursor, cursor)

    if (this.mode === 'visual-line') {
      from = lineStart(text, from)
      to = Math.min(text.length, lineEnd(text, to) + 1)
    } else {
      to = nextGrapheme(text, to)
    }

    return { from, to, linewise: this.mode === 'visual-line' }
  }
  #operate(operator: Operator, range: Range) {
    const { text } = this.composer
    let { from, to } = range

    if (range.linewise && operator === 'c' && text[to - 1] === '\n') {
      to--
    }

    if (range.linewise && operator !== 'c') {
      to = Math.min(text.length, lineEnd(text, Math.max(from, to - (text[to - 1] === '\n' ? 1 : 0))) + 1)
    }

    this.#register = text.slice(from, to)
    this.#linewise = range.linewise === true

    if (operator !== 'y') {
      // Deleting the last whole line also removes its preceding separator, but yanking does not.
      if (
        range.linewise &&
        operator === 'd' &&
        to === text.length &&
        from > 0 &&
        (text[to - 1] !== '\n' || from === to)
      ) {
        from--
      }

      this.composer.splice(from, to, '')
    } else {
      this.composer.move(from)
    }

    this.#mode(operator === 'c' ? 'insert' : 'normal')
  }
  #operatorKey(operator: Operator, count: number) {
    if (this.visual) {
      this.#operate(operator, this.#range())

      return
    }

    if (this.#operator === operator) {
      const { text, cursor } = this.composer
      const start = lineStart(text, cursor)
      const line = text.slice(0, start).split('\n').length - 1
      this.#operate(operator, { from: start, to: lineEnd(text, this.#line(line + count - 1)), linewise: true })

      return
    }

    this.#operator = operator
    this.#operatorCount = count
    this.#count = ''
  }
  #replace(value: string) {
    const chars = [...segments.segment(value)]
    const { text, cursor } = this.composer
    const count = Number(this.#count || 1)

    if (chars.length !== 1) {
      this.#clear()

      return
    }

    const range = this.visual
      ? this.#range()
      : { from: cursor, to: Math.min(lineEnd(text, cursor), this.#step(cursor, count, 1)) }

    const replacement = [...segments.segment(text.slice(range.from, range.to))]
      .map(part => (part.segment === '\n' ? '\n' : value))
      .join('')

    this.composer.splice(range.from, range.to, replacement, range.from)
    this.#mode('normal')
  }
  #paste(after: boolean, count: number) {
    if (!this.#register) {
      this.#clear()

      return
    }

    const { text, cursor } = this.composer

    if (this.visual) {
      const range = this.#range()
      this.composer.splice(range.from, range.to, this.#register.repeat(count), range.from)
    } else if (this.#linewise) {
      const at = after ? lineEnd(text, cursor) : lineStart(text, cursor)
      const value = this.#register.replace(/\n$/, '').concat('\n').repeat(count)

      if (after && at === text.length) {
        this.composer.splice(at, at, '\n' + value.slice(0, -1), at + 1)
      } else {
        const from = after ? at + 1 : at
        this.composer.splice(from, from, value, from)
      }
    } else {
      const at = after ? Math.min(lineEnd(text, cursor), nextGrapheme(text, cursor)) : cursor
      this.composer.splice(at, at, this.#register.repeat(count), at)
    }

    this.#mode('normal')
  }
  #commands(count: number): Record<string, () => void> {
    const { text, cursor } = this.composer

    const insert = (at: number) => {
      this.composer.move(at)
      this.#mode('insert')
    }

    const visual = (mode: VimMode) => {
      if (this.mode === mode) {
        this.#mode('normal')
      } else {
        this.anchor ??= cursor
        this.#mode(mode)
      }
    }

    return {
      g: () => {
        this.#prefix = 'g'
      },
      i: () => insert(cursor),
      a: () => insert(Math.min(lineEnd(text, cursor), nextGrapheme(text, cursor))),
      I: () => insert(lineStart(text, cursor)),
      A: () => insert(lineEnd(text, cursor)),
      o: () => {
        const at = lineEnd(text, cursor)
        this.composer.splice(at, at, '\n')
        this.#mode('insert')
      },
      O: () => {
        const at = lineStart(text, cursor)
        this.composer.splice(at, at, '\n', at)
        this.#mode('insert')
      },
      v: () => visual('visual'),
      V: () => visual('visual-line'),
      d: () => this.#operatorKey('d', count),
      c: () => this.#operatorKey('c', count),
      y: () => this.#operatorKey('y', count),
      x: () =>
        this.#operate(
          'd',
          this.visual
            ? this.#range()
            : { from: cursor, to: Math.min(lineEnd(text, cursor), this.#step(cursor, count, 1)) }
        ),
      D: () => this.#operate('d', { from: cursor, to: lineEnd(text, cursor) }),
      C: () => this.#operate('c', { from: cursor, to: lineEnd(text, cursor) }),
      r: () => {
        this.#prefix = 'r'
      },
      u: () => {
        this.composer.undo()
        this.#mode('normal')
      },
      redo: () => {
        this.composer.redo()
        this.#mode('normal')
      },
      p: () => this.#paste(true, count),
      P: () => this.#paste(false, count)
    }
  }
}


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

/** UTF-16 offsets are the TSP editor's convention; motion always lands on a grapheme boundary. */
function lineStart(text: string, at: number): number {
  return at <= 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1
}

function lineEnd(text: string, at: number): number {
  const end = text.indexOf('\n', at)
  return end === -1 ? text.length : end
}

function prevGrapheme(text: string, at: number): number {
  let prev = 0
  for (const { index } of segments.segment(text)) {
    if (index >= at) break
    prev = index
  }
  return prev
}

function nextGrapheme(text: string, at: number): number {
  for (const { index, segment } of segments.segment(text)) {
    if (index >= at) return index + segment.length
  }
  return text.length
}
