// Readline word motions shared by the composer's Ctrl/Alt bindings.
const WORD = /[\p{L}\p{N}_]/u

export function prevWord(text: string, at: number): number {
  let i = at

  while (i > 0 && !WORD.test(text[i - 1] ?? '')) {
    i--
  }

  while (i > 0 && WORD.test(text[i - 1] ?? '')) {
    i--
  }

  return i
}

export function nextWord(text: string, at: number): number {
  let i = at

  while (i < text.length && !WORD.test(text[i] ?? '')) {
    i++
  }

  while (i < text.length && WORD.test(text[i] ?? '')) {
    i++
  }

  return i
}
