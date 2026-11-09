import { describe, it, expect } from 'vitest'
import { diffMinutes, normalizeTimeInput, round2, toMinutes } from '../lib/time'

describe('normalizeTimeInput', () => {
  it.each([
    ['08:30', '08:30'],
    ['8:30', '08:30'],
    ['0830', '08:30'],
    ['830', '08:30'],
    ['1747', '17:47'],
    ['17:47', '17:47'],
    ['00:00', '00:00'],
    ['23:59', '23:59'],
    ['  09:05  ', '09:05'],
  ])('accepts %j as %j', (raw, expected) => {
    expect(normalizeTimeInput(raw)).toBe(expected)
  })

  it.each([
    ['24:00'],
    ['25:00'],
    ['12:60'],
    ['2360'],
    [''],
    ['   '],
    ['abc'],
    ['8'],
    ['830pm'],
    ['08:5'],
    ['8:30:00'],
    ['-8:30'],
  ])('rejects %j', (raw) => {
    expect(normalizeTimeInput(raw)).toBeNull()
  })
})

describe('toMinutes / diffMinutes', () => {
  it('converts HH:mm to minutes since midnight', () => {
    expect(toMinutes('00:00')).toBe(0)
    expect(toMinutes('07:40')).toBe(460)
    expect(toMinutes('23:59')).toBe(1439)
  })

  it('is positive when b is later and negative when earlier', () => {
    expect(diffMinutes('07:40', '13:04')).toBe(324)
    expect(diffMinutes('13:04', '07:40')).toBe(-324)
    expect(diffMinutes('08:00', '08:00')).toBe(0)
  })
})

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(3.1666666)).toBe(3.17)
    expect(round2(0.05)).toBe(0.05)
    expect(round2(1.005)).toBe(1.01)
    expect(round2(1.25)).toBe(1.25)
  })

  it('leaves whole numbers alone', () => {
    expect(round2(8)).toBe(8)
    expect(round2(0)).toBe(0)
  })
})
