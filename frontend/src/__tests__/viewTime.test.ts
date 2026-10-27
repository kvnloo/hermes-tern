import { describe, expect, it } from 'vitest'

import { age, compact, countdownAge } from '../view/time.js'

describe('view/time', () => {
  it('age_firstUse', () => {
    expect(age({}, 100, 150)).toBe(50)
  })

  it('age_cachedPerOwner', () => {
    const owner = {}

    expect(age(owner, 100, 150)).toBe(50)
    expect(age(owner, 100, 900)).toBe(50)
    expect(age(owner, 0, 5000)).toBe(50)
  })

  it('age_ownersIndependent', () => {
    const firstOwner = {}
    const secondOwner = {}

    expect(age(firstOwner, 100, 150)).toBe(50)
    expect(age(secondOwner, 100, 400)).toBe(300)
    expect(age(firstOwner, 100, 900)).toBe(50)
  })

  it('age_clampsNegative', () => {
    const owner = {}

    expect(age(owner, 200, 100)).toBe(0)
    expect(age(owner, 0, 999)).toBe(0)
  })

  it('countdownAge_negative', () => {
    const owner = {}

    expect(countdownAge(owner, 1000, 400)).toBe(-600)
    expect(countdownAge(owner, 0, 999)).toBe(-600)
  })

  it('countdownAge_clampsPast', () => {
    expect(countdownAge({}, 100, 400)).toBe(0)
  })

  it('age_countdown_shareSlot', () => {
    const owner = {}

    // Current behavior: age and countdownAge cache in the same private symbol slot.
    expect(age(owner, 100, 150)).toBe(50)
    expect(countdownAge(owner, 1000, 400)).toBe(50)
  })

  it('compact_small', () => {
    expect(compact(0)).toBe('0')
    expect(compact(999)).toBe('999')
  })

  it('compact_thousands', () => {
    expect(compact(1000)).toBe('1K')
    expect(compact(1234)).toBe('1.2K')
    expect(compact(1500)).toBe('1.5K')
    expect(compact(9500)).toBe('9.5K')
    expect(compact(9999)).toBe('10K')
    expect(compact(10_000)).toBe('10K')
    expect(compact(12_345)).toBe('12K')
    expect(compact(34_500)).toBe('35K')
  })

  it('compact_millions', () => {
    expect(compact(1_000_000)).toBe('1M')
    expect(compact(2_500_000)).toBe('2.5M')
    expect(compact(12_400_000)).toBe('12M')
    expect(compact(9_999_999)).toBe('10M')
  })

  it('compact_nonInteger', () => {
    expect(compact(999.5)).toBe('999.5')
  })

  it('compact_boundaryBelowMillion', () => {
    // Near one million, rounded 1000K must promote to 1M instead of returning 1000K.
    expect(compact(999_499)).toBe('999K')
    expect(compact(999_500)).toBe('1M')
    expect(compact(999_999)).toBe('1M')
  })
})
