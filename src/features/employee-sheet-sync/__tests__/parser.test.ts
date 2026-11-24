import { describe, expect, it } from 'vitest'
import { parseSheet } from '../lib/parser'
import { SheetSyncError } from '../types/employee-sheet-sync.types'
import fixture from '../fixtures/employee-master.fixture.json'

const REQ = ['Sr.', 'Employee ID', 'Employee Name', 'Designation', 'Salary', 'Date of Joining']

const DEFAULTS: Record<string, string> = {
  'Sr.': '1',
  'Employee ID': 'TPLGOAMSN001',
  'Employee Name': 'A',
  Designation: 'MASON',
  Salary: '800',
  'Date of Joining': '01/01/2025',
}

function sheet(header: string[], ...rows: string[][]) {
  return { header, rows }
}
const full = (o: Record<string, string> = {}) => REQ.map((h) => o[h] ?? DEFAULTS[h])

describe('parseSheet', () => {
  it('parses a simple row; row number is index + 2', () => {
    const r = parseSheet(sheet(REQ, full(), full({ 'Sr.': '2' })))
    expect(r.rows.map((x) => x.rowNumber)).toEqual([2, 3])
    expect(r.rows[0]).toMatchObject({
      sr: 1,
      srRaw: '1',
      employeeIdRaw: 'TPLGOAMSN001',
      salary: { value: 800 },
      requiredErrors: [],
    })
    expect(r.rows[0].fields.dateOfJoining).toBe('2025-01-01')
  })

  it('matches headers case-insensitively, collapsing whitespace, in any order', () => {
    const header = ['  date  of JOINING', 'SALARY', 'designation', 'employee   name', 'employee id', 'SR.']
    const row = ['01/01/2025', '800', 'MASON', 'A', 'TPLGOAMSN001', '1']
    const r = parseSheet(sheet(header, row))
    expect(r.rows[0].sr).toBe(1)
    expect(r.rows[0].fields.employeeName).toBe('A')
    expect(r.rows[0].salary.value).toBe(800)
  })

  it('first duplicate header wins', () => {
    const header = [...REQ, 'Employee Name']
    const r = parseSheet(sheet(header, [...full(), 'Second']))
    expect(r.rows[0].fields.employeeName).toBe('A')
  })

  it('missing required headers fail with the list in detail', () => {
    let caught: unknown
    try {
      parseSheet(sheet(['Sr.', 'Employee ID'], ['1', 'X1']))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SheetSyncError)
    expect((caught as SheetSyncError).code).toBe('MISSING_REQUIRED_HEADERS')
    expect((caught as SheetSyncError).detail).toEqual({
      missing: ['Employee Name', 'Designation', 'Salary', 'Date of Joining'],
    })
  })

  it('empty sheet throws EMPTY_SHEET', () => {
    expect(() => parseSheet({ header: [], rows: [] })).toThrowError(expect.objectContaining({ code: 'EMPTY_SHEET' }))
    expect(() => parseSheet({ header: ['', ' '], rows: [['', '']] })).toThrowError(
      expect.objectContaining({ code: 'EMPTY_SHEET' }),
    )
  })

  it('header only (no rows) yields no rows', () => {
    expect(parseSheet(sheet(REQ)).rows).toEqual([])
  })

  it('ignores all-blank rows silently and keeps later row numbers', () => {
    const r = parseSheet(sheet(REQ, full(), ['', '', '', '', '', ''], [' ', '', '', '', '', ''], full({ 'Sr.': '2' })))
    expect(r.rows.map((x) => x.rowNumber)).toEqual([2, 5])
  })

  it('pads short rows', () => {
    const r = parseSheet(sheet(REQ, ['1', 'TPLGOAMSN001']))
    expect(r.rows[0].fields.employeeName).toBeNull()
    expect(r.rows[0].requiredErrors.map((e) => e.field).sort()).toEqual(
      ['dateOfJoining', 'designation', 'employeeName', 'salary'].sort(),
    )
  })

  it('Sr. rules: XXX/blank/12a invalid, leading zeros kept in srRaw', () => {
    const r = parseSheet(
      sheet(REQ, full({ 'Sr.': 'XXX' }), full({ 'Sr.': '' }), full({ 'Sr.': '12a' }), full({ 'Sr.': ' 007 ' })),
    )
    expect(r.rows.map((x) => x.sr)).toEqual([null, null, null, 7])
    expect(r.rows[3].srRaw).toBe('007')
  })

  it('Employee ID blank markers become null', () => {
    const r = parseSheet(
      sheet(REQ, full({ 'Employee ID': '#N/A' }), full({ 'Employee ID': '' }), full({ 'Employee ID': 'X' })),
    )
    expect(r.rows.map((x) => x.employeeIdRaw)).toEqual([null, null, null])
  })

  it.each(['4000/week', '0', '-5', '1,000', ''])('invalid salary %j is a required error with null value', (bad) => {
    const r = parseSheet(sheet(REQ, full({ Salary: bad })))
    expect(r.rows[0].salary.value).toBeNull()
    expect(r.rows[0].requiredErrors.map((e) => e.field)).toContain('salary')
  })

  it('decimal salary 833.34 is kept', () => {
    expect(parseSheet(sheet(REQ, full({ Salary: '833.34' }))).rows[0].salary.value).toBe(833.34)
  })

  it('invalid required date is a required error and a field warning, and not in fields', () => {
    const r = parseSheet(sheet(REQ, full({ 'Date of Joining': '2026-11-03' })))
    expect(r.rows[0].requiredErrors.map((e) => e.field)).toContain('dateOfJoining')
    expect(r.rows[0].warnings[0]).toMatchObject({ field: 'dateOfJoining', reason: 'INVALID_DATE', raw: '2026-11-03' })
    expect('dateOfJoining' in r.rows[0].fields).toBe(false)
  })

  it('invalid optional date warns and leaves the field out; blank marker date is null', () => {
    const header = [...REQ, 'D.O.B', 'Date of Resignation']
    const r = parseSheet(sheet(header, [...full(), '31/02/1990', 'X']))
    expect('dateOfBirth' in r.rows[0].fields).toBe(false)
    expect(r.rows[0].fields.dateOfResignation).toBeNull()
    expect(r.rows[0].warnings).toHaveLength(1)
    expect(r.rows[0].warnings[0]).toMatchObject({ field: 'dateOfBirth', header: 'D.O.B', reason: 'INVALID_DATE' })
  })

  it('invalid Active gives a warning and activeInvalid; blank gives null', () => {
    const header = [...REQ, 'Active']
    const r = parseSheet(sheet(header, [...full(), 'Maybe'], [...full(), ''], [...full(), 'Inactive']))
    expect(r.rows[0].activeInvalid).toBe(true)
    expect(r.rows[0].warnings.map((w) => w.reason)).toContain('INVALID_ACTIVE')
    expect(r.rows[1]).toMatchObject({ activeInvalid: false, active: { value: null } })
    expect(r.rows[2].active.value).toBe(false)
  })

  it('missing optional headers are absent from presentFields and fields', () => {
    const r = parseSheet(sheet(REQ, full()))
    expect(r.presentFields).not.toContain('phone')
    expect(r.presentFields).toEqual(expect.arrayContaining(['employeeName', 'designation', 'dateOfJoining']))
    expect('phone' in r.rows[0].fields).toBe(false)
  })

  it('blank optional cell is null, quoted bank account keeps leading zeros, whatsapp normalised', () => {
    const header = [...REQ, 'Bank Account No.', 'WhatsApp', 'Phone']
    const r = parseSheet(sheet(header, [...full(), '"0009201700065570"', 'wa.me/919567031213', 'X']))
    expect(r.rows[0].fields.bankAccount).toBe('0009201700065570')
    expect(r.rows[0].fields.whatsappNumber).toBe('9567031213')
    expect(r.rows[0].fields.phone).toBeNull()
  })

  it('Aadhar spelling alias maps to aadhaarId', () => {
    const r = parseSheet(sheet([...REQ, 'Aadhar Card'], [...full(), '123412341234']))
    expect(r.rows[0].fields.aadhaarId).toBe('123412341234')
  })

  it('ignores the Hourly Rate column', () => {
    const r = parseSheet(sheet([...REQ, 'Hourly Rate'], [...full(), '999']))
    expect(Object.keys(r.rows[0].fields)).not.toContain('hourlyRate')
  })

  it('parses the shipped fixture end to end', () => {
    const r = parseSheet(fixture as { header: string[]; rows: string[][] })
    expect(r.rows).toHaveLength(5) // trailing blank row dropped
    const byRow = Object.fromEntries(r.rows.map((x) => [x.rowNumber, x]))
    expect(byRow[2].fields.dateOfJoining).toBe('2026-11-03')
    expect(byRow[2].fields.dateOfBirth).toBe('1989-12-07')
    expect(byRow[2].fields.bankAccount).toBe('0009201700065570')
    expect(byRow[3].sr).toBeNull()
    expect(byRow[5].salary.value).toBeNull()
  })
})
