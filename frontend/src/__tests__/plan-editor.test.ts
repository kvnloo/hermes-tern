import { readFile, stat, writeFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { editPlanExternal } from '../plan-editor.js'

describe('private external plan editor', () => {
  it('round-trips a private revision and unlinks the temporary file on success', async () => {
    let file = ''
    const result = await editPlanExternal('# Original', async path => {
      file = path
      expect(await readFile(path, 'utf8')).toBe('# Original')
      await writeFile(path, '# Edited')
    })

    expect(result).toBe('# Edited')
    await expect(stat(file)).rejects.toThrow()
  })

  it('unlinks the temporary file on cancellation without returning replacement text', async () => {
    let file = ''

    await expect(editPlanExternal('# Keep', path => {
      file = path
      throw new Error('Editor cancelled')
    })).rejects.toThrow('Editor cancelled')

    await expect(stat(file)).rejects.toThrow()
  })
})
