import { describe, expect, it } from 'vitest'

import { splitPrompt } from '../transcript/promptRefs.js'

const tick = String.fromCharCode(96)

describe('persisted prompt image provenance', () => {
  it('lifts only a terminal absolute-path suffix, including quoted paths and matching placeholders', () => {
    expect(splitPrompt('words\n@image:/var/img/one.png\n@image:' + tick + '/var/img/two images.png' + tick + '\n[screenshot]\n[screenshot]'))
      .toEqual({ files: [], images: ['/var/img/one.png', '/var/img/two images.png'], text: 'words' })
    expect(splitPrompt('words\n@image:"/tmp/one image.png"'))
      .toEqual({ files: [], images: ['/tmp/one image.png'], text: 'words' })
  })

  it('preserves earlier absolute-looking examples and literal prose', () => {
    const text = 'Document this literal:\n@image:/tmp/example.png\nIt is only an example.'
    expect(splitPrompt(text)).toEqual({ files: [], images: [], text })
    const withActual = text + '\n@image:/tmp/real.png'
    expect(splitPrompt(withActual)).toEqual({ files: [], images: ['/tmp/real.png'], text })
  })

  it('does not interpret directives inside code fences as attachment metadata', () => {
    const codeFence = tick.repeat(3)
    for (const input of [
      codeFence + 'md\n@image:/tmp/code.png\n' + codeFence,
      '~~~text\n@image:/tmp/code.png\n~~~',
      codeFence + 'md\n@image:/tmp/code.png'
    ]) {
      expect(splitPrompt(input)).toEqual({ files: [], images: [], text: input })
    }
    const input = codeFence + 'text\n@image:/tmp/illustration.png\n' + codeFence + '\nActual request\n@image:/tmp/upload.png'
    expect(splitPrompt(input)).toEqual({
      files: [], images: ['/tmp/upload.png'], text: codeFence + 'text\n@image:/tmp/illustration.png\n' + codeFence + '\nActual request'
    })
  })

  it('preserves relative directives, mismatched placeholders and user-typed screenshot text', () => {
    for (const text of [
      'words\n@image:./relative.png',
      'words\n@image:relative/file.png',
      'words\n@image:/tmp/x.png\n[screenshot]\n[screenshot]',
      'words\n[screenshot]'
    ]) {
      expect(splitPrompt(text)).toEqual({ files: [], images: [], text })
    }
  })

  it('keeps native vision hints with their existing separate provenance', () => {
    expect(splitPrompt('look\n\n[Image attached at: /tmp/hint.png]\n[screenshot]'))
      .toEqual({ files: [], images: ['/tmp/hint.png'], text: 'look' })
  })
})
