import { describe, expect, it, vi } from 'vitest'

import { clipboardDraft } from '../artifacts/clipboard.js'
import { copyToClipboard } from '../clipboard.js'

describe('copying a composer artifact', () => {
  it('takes all text or the current line, with UTF-16 caret offsets', () => {
    const draft = 'one\n🙂 two\nthird\n'
    expect(clipboardDraft(draft, 7)).toBe(draft)
    expect(clipboardDraft(draft, 7, true)).toBe('🙂 two')
    expect(clipboardDraft(draft, draft.length, true)).toBe('')
    expect(clipboardDraft(draft, -5, true)).toBe('one')
    expect(clipboardDraft('x\n', 2, true)).toBe('')
  })

  it('uses the plugin OSC 52 channel without claiming a host clipboard acknowledgement', () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    try {
      copyToClipboard('π\nnotes', { SSH_CONNECTION: 'test' })
      const expected = '\x1b]52;c;' + Buffer.from('π\nnotes').toString('base64') + '\x07'
      expect(output).toHaveBeenCalledWith(expected)
    } finally {
      output.mockRestore()
    }
  })
})
