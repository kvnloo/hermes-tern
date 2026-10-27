import { describe, expect, it } from 'vitest'

import { FIELD_NAME, betterValue, choice, cut, fieldName, list, num, str } from '../processes/widgets/check.js'

describe('processes/widgets/check', () => {
  it('cut: truncates with an ellipsis only beyond the limit, including a one-character limit', () => {
    expect(cut('abcdef', 4)).toBe('abc…')
    expect(cut('abcd', 4)).toBe('abcd')
    expect(cut('ab', 1)).toBe('…')
  })

  it('list_ok: returns the same array at intermediate, minimum and maximum lengths', () => {
    const errors: string[] = []
    const within = [1, 2]
    const atMin = [1]
    const atMax = [1, 2, 3]

    expect(list(within, 'b', errors, 1, 3)).toBe(within)
    expect(list(atMin, 'b', errors, 1, 3)).toBe(atMin)
    expect(list(atMax, 'b', errors, 1, 3)).toBe(atMax)
    expect(errors).toEqual([])
  })

  it('list_errors: rejects non-arrays and lengths outside the inclusive range', () => {
    const errors: string[] = []

    expect(list('x', 'b', errors, 1, 3)).toBeUndefined()
    expect(list([], 'b', errors, 1, 3)).toBeUndefined()
    expect(list([1, 2, 3, 4], 'b', errors, 1, 3)).toBeUndefined()
    expect(errors).toEqual([
      'b: expected an array',
      'b: expected 1–3 entries, got 0',
      'b: expected 1–3 entries, got 4',
    ])
  })

  it('str_basics: trims values, ignores absent optional fields, and requires missing fields', () => {
    const errors: string[] = []

    expect(str('  hi ', 'w', errors)).toBe('hi')
    expect(str(undefined, 'w', errors)).toBeUndefined()
    expect(str(null, 'w', errors)).toBeUndefined()
    expect(errors).toEqual([])
    expect(str(undefined, 'w', errors, { required: true })).toBeUndefined()
    expect(errors).toEqual(['w: required'])
  })

  it('str_wrongTypeAndBlank: rejects wrong types, ignores optional blanks and rejects required blanks', () => {
    const errors: string[] = []

    expect(str(5, 'w', errors)).toBeUndefined()
    expect(errors).toEqual(['w: expected a string'])
    expect(str('   ', 'w', errors)).toBeUndefined()
    expect(errors).toEqual(['w: expected a string'])
    expect(str('   ', 'w', errors, { required: true })).toBeUndefined()
    expect(errors).toEqual(['w: expected a string', 'w: must not be empty'])
  })

  it('str_max: accepts the limit and measures length after trimming', () => {
    const errors: string[] = []

    expect(str('abc', 'w', errors, { max: 3 })).toBe('abc')
    expect(str(' abc ', 'w', errors, { max: 3 })).toBe('abc')
    expect(errors).toEqual([])
    expect(str('abcd', 'w', errors, { max: 3 })).toBeUndefined()
    expect(errors).toEqual(['w: at most 3 characters'])
  })

  it('str_cutUnescapes: unescapes supported entities once before cutting, but only with cut', () => {
    const errors: string[] = []

    expect(str('ACL &amp; update', 'w', errors, { cut: 50 })).toBe('ACL & update')
    expect(str('&lt;b&gt; &quot;x&quot; &#39;y&#39;', 'w', errors, { cut: 50 })).toBe('<b> "x" \'y\'')
    expect(str('&nbsp;', 'w', errors, { cut: 50 })).toBe('&nbsp;')
    expect(str('&amp;lt;', 'w', errors, { cut: 50 })).toBe('&lt;')
    expect(str('abcdefgh', 'w', errors, { cut: 5 })).toBe('abcd…')
    expect(str('a &amp; b', 'w', errors)).toBe('a &amp; b')
    expect(errors).toEqual([])
  })

  it('num: accepts finite numbers and absent values but rejects non-finite and non-numeric input', () => {
    const errors: string[] = []

    expect(num(0, 'n', errors)).toBe(0)
    expect(num(-3.5, 'n', errors)).toBe(-3.5)
    expect(num(42, 'n', errors)).toBe(42)
    expect(num(undefined, 'n', errors)).toBeUndefined()
    expect(num(null, 'n', errors)).toBeUndefined()
    expect(errors).toEqual([])
    expect(num(NaN, 'n', errors)).toBeUndefined()
    expect(num(Infinity, 'n', errors)).toBeUndefined()
    expect(num('5', 'n', errors)).toBeUndefined()
    expect(num(true, 'n', errors)).toBeUndefined()
    expect(errors).toEqual(Array(4).fill('n: expected a finite number'))
  })

  it('fieldName_ok: accepts lower-case identifiers, trims and allows 24 characters', () => {
    const errors: string[] = []

    expect(fieldName('rate_1', 'f', errors)).toBe('rate_1')
    expect(fieldName(' ok ', 'f', errors)).toBe('ok')
    expect(fieldName('a'.repeat(24), 'f', errors)).toBe('a'.repeat(24))
    expect(errors).toEqual([])
  })

  it('fieldName_errors: rejects malformed or long names and distinguishes missing, blank and typed values', () => {
    const errors: string[] = []
    const malformed = ['Bad', '1x', 'x-y', 'a'.repeat(25)]

    for (const name of malformed) {
      expect(fieldName(name, 'f', errors)).toBeUndefined()
    }
    expect(fieldName(undefined, 'f', errors)).toBeUndefined()
    expect(fieldName('', 'f', errors)).toBeUndefined()
    expect(fieldName(5, 'f', errors)).toBeUndefined()
    expect(errors).toEqual([
      ...malformed.map(name => `f: "${name}" must match ${FIELD_NAME.source}`),
      'f: required',
      'f: must not be empty',
      'f: expected a string',
    ])
  })

  it('FIELD_NAME: matches only lower-case field identifiers, consistently on repeated calls', () => {
    expect(FIELD_NAME.test('a')).toBe(true)
    expect(FIELD_NAME.test('a_9')).toBe(true)
    expect(FIELD_NAME.test('A')).toBe(false)
    expect(FIELD_NAME.test('')).toBe(false)
    expect(FIELD_NAME.global).toBe(false)
    expect(FIELD_NAME.test('a')).toBe(true)
  })

  it('choice: accepts an allowed literal and reports invalid strings and types', () => {
    const errors: string[] = []
    const choices = ['sum', 'avg'] as const

    expect(choice('sum', choices, 'w', errors)).toBe('sum')
    expect(errors).toEqual([])
    expect(choice('max', choices, 'w', errors)).toBeUndefined()
    expect(choice(5, choices, 'w', errors)).toBeUndefined()
    expect(errors).toEqual(['w: expected one of sum, avg', 'w: expected one of sum, avg'])
  })

  it('betterValue: accepts higher/lower, ignores absent input and rejects other directions', () => {
    const errors: string[] = []

    expect(betterValue('higher', 'w', errors)).toBe('higher')
    expect(betterValue('lower', 'w', errors)).toBe('lower')
    expect(betterValue(undefined, 'w', errors)).toBeUndefined()
    expect(betterValue(null, 'w', errors)).toBeUndefined()
    expect(errors).toEqual([])
    expect(betterValue('up', 'w', errors)).toBeUndefined()
    expect(errors).toEqual(['w: expected "higher" or "lower"'])
  })

  it('errorsAccumulate: appends errors from separate validators in call order', () => {
    const errors: string[] = []

    expect(str(5, 'title', errors)).toBeUndefined()
    expect(list([1, 2, 3, 4], 'blocks', errors, 1, 3)).toBeUndefined()
    expect(errors).toEqual([
      'title: expected a string',
      'blocks: expected 1–3 entries, got 4',
    ])
  })
})
