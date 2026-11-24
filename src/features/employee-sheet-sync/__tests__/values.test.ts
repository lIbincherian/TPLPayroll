import { describe, expect, it } from 'vitest'
import {
  cleanIdText,
  isBlankMarker,
  parseActive,
  parseDayFirstDate,
  parseSalary,
  parseWhatsapp,
} from '../lib/values'

describe('isBlankMarker', () => {
  it.each(['', '   ', 'X', 'x', 'Y', 'y', '#N/A', '#REF!', '#VALUE!', ' #n/a '])('treats %j as blank', (raw) => {
    expect(isBlankMarker(raw)).toBe(true)
  })
  it('treats null/undefined as blank', () => {
    expect(isBlankMarker(null)).toBe(true)
    expect(isBlankMarker(undefined)).toBe(true)
  })
  it.each(['XX', 'XXX', 'Yes', 'Xavier', '0', 'N/A'])('keeps %j as a value', (raw) => {
    expect(isBlankMarker(raw)).toBe(false)
  })
})

describe('cleanIdText', () => {
  it('strips straight, single and curly quotes and keeps leading zeros', () => {
    expect(cleanIdText('"0009201700065570"')).toBe('0009201700065570')
    expect(cleanIdText("'0009201700065570'")).toBe('0009201700065570')
    expect(cleanIdText('“0012”')).toBe('0012')
    expect(cleanIdText('  "  0012 " ')).toBe('0012')
  })
  it('leaves unquoted and half-quoted text alone', () => {
    expect(cleanIdText(' 123 ')).toBe('123')
    expect(cleanIdText('"123')).toBe('"123')
  })
})

describe('parseDayFirstDate', () => {
  it.each([
    ['03/11/26', '2026-11-03'],
    ['3/1/2026', '2026-01-03'],
    ['03/11/2026', '2026-11-03'],
    ['19-03-1990', '1990-03-19'],
    ['7 December 1989', '1989-12-07'],
    ['7 Dec 1989', '1989-12-07'],
    ['29/02/2024', '2024-02-29'],
  ])('parses %s', (raw, iso) => {
    expect(parseDayFirstDate(raw)).toEqual({ ok: true, value: iso })
  })

  it.each([
    ['impossible day', '31/02/2026'],
    ['month first', '11/13/2026'],
    ['ISO', '2026-11-03'],
    ['non-leap 29 Feb', '29/02/2025'],
    ['text', 'soon'],
    ['empty', ''],
    ['unknown month', '7 Foo 1989'],
    ['zero day', '00/01/2026'],
  ])('rejects %s (%s)', (_label, raw) => {
    expect(parseDayFirstDate(raw)).toEqual({ ok: false })
  })
})

describe('parseSalary', () => {
  it('accepts plain and decimal numbers', () => {
    expect(parseSalary('900')).toBe(900)
    expect(parseSalary('833.34')).toBe(833.34)
    expect(parseSalary(' "800" ')).toBe(800)
  })
  it.each(['4000/week', '0', '-5', '1,000', '', 'abc', '12.', '.5', '0.00'])('rejects %j', (raw) => {
    expect(parseSalary(raw)).toBeNull()
  })
})

describe('parseWhatsapp', () => {
  it.each([
    ['wa.me/919567031213', '9567031213'],
    ['https://wa.me/919567031213', '9567031213'],
    ['https://wa.me/919567031213?text=hi', '9567031213'],
    ['+91 98765 43210', '9876543210'],
    ['919876543210', '9876543210'],
    ['9876543210', '9876543210'],
  ])('normalises %s', (raw, expected) => {
    expect(parseWhatsapp(raw)).toBe(expected)
  })
  it('returns null for blank markers', () => {
    expect(parseWhatsapp('X')).toBeNull()
    expect(parseWhatsapp('#N/A')).toBeNull()
    expect(parseWhatsapp('')).toBeNull()
  })
  it('keeps unrecognised text as written', () => {
    expect(parseWhatsapp('call office')).toBe('call office')
  })
})

describe('parseActive', () => {
  it('maps Active/Inactive case-insensitively', () => {
    expect(parseActive('Active')).toEqual({ ok: true, value: true })
    expect(parseActive(' ACTIVE ')).toEqual({ ok: true, value: true })
    expect(parseActive('inactive')).toEqual({ ok: true, value: false })
  })
  it('blank is ok with null', () => {
    expect(parseActive('')).toEqual({ ok: true, value: null })
    expect(parseActive('X')).toEqual({ ok: true, value: null })
  })
  it('anything else is invalid', () => {
    expect(parseActive('Maybe')).toEqual({ ok: false })
    expect(parseActive('Yes')).toEqual({ ok: false })
  })
})
