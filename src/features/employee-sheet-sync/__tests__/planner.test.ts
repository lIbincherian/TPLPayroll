import { describe, expect, it } from 'vitest'
import { parseSheet } from '../lib/parser'
import { hashPlan, planSync } from '../lib/planner'
import { SHEET_OWNED_FIELDS } from '../lib/columns'
import type { EmployeeSnapshot, FieldValue, SheetOwnedField } from '../types/employee-sheet-sync.types'

const TODAY = new Date('2026-11-24T00:00:00.000Z')
const HEADER = ['Sr.', 'Employee ID', 'Employee Name', 'Designation', 'Salary', 'Date of Joining', 'Active', 'Phone', 'Site']

function row(o: Partial<Record<string, string>> = {}): string[] {
  const d: Record<string, string> = {
    'Sr.': '1',
    'Employee ID': 'TPLGOAMSN001',
    'Employee Name': 'Ravi',
    Designation: 'MASON',
    Salary: '800',
    'Date of Joining': '01/01/2025',
    Active: '',
    Phone: '',
    Site: '',
  }
  return HEADER.map((h) => o[h] ?? d[h])
}

function plan(rows: string[][], snapshot: EmployeeSnapshot[] = [], header = HEADER) {
  return planSync(parseSheet({ header, rows }), snapshot, TODAY)
}

function emp(over: Partial<Omit<EmployeeSnapshot, 'fields'>> & { fields?: Partial<Record<SheetOwnedField, FieldValue>> } = {}): EmployeeSnapshot {
  const fields = {} as Record<SheetOwnedField, FieldValue>
  for (const f of SHEET_OWNED_FIELDS) fields[f] = null
  Object.assign(fields, { employeeName: 'Ravi', designation: 'MASON', dateOfJoining: '2025-01-01' }, over.fields ?? {})
  return {
    id: 'db-1',
    employeeId: 'TPLGOAMSN001',
    employeeName: 'Ravi',
    number: 1,
    isActive: true,
    openWage: 800,
    ...over,
    fields,
  }
}

describe('planSync: skips', () => {
  it('SR_INVALID for XXX, blank, 12a', () => {
    const p = plan([row({ 'Sr.': 'XXX' }), row({ 'Sr.': '' }), row({ 'Sr.': '12a' })])
    expect(p.skips.map((s) => s.reason)).toEqual(['SR_INVALID', 'SR_INVALID', 'SR_INVALID'])
    expect(p.creates).toHaveLength(0)
  })

  it('SR_DUPLICATE skips both rows', () => {
    const p = plan([row({ 'Sr.': '5', 'Employee ID': 'TPLGOAMSN005' }), row({ 'Sr.': '5', 'Employee ID': 'TPLGOAMSN005' })])
    expect(p.skips.map((s) => s.reason)).toEqual(['SR_DUPLICATE', 'SR_DUPLICATE'])
    expect(p.creates).toHaveLength(0)
  })

  it('AMBIGUOUS_APP_MATCH when two app employees share the number', () => {
    const p = plan(
      [row()],
      [emp({ id: 'a', employeeId: 'TPLGOAMSN001' }), emp({ id: 'b', employeeId: 'TPLGOAHLP001' })],
    )
    expect(p.skips[0].reason).toBe('AMBIGUOUS_APP_MATCH')
    expect(p.updates).toHaveLength(0)
  })

  it.each(['#N/A', '', 'X', 'NOID'])('NEW_EMPLOYEE_ID_INVALID for new row with ID %j, with a lookup hint', (id) => {
    const p = plan([row({ 'Sr.': '902', 'Employee ID': id })])
    expect(p.skips[0].reason).toBe('NEW_EMPLOYEE_ID_INVALID')
    expect(p.skips[0].detail).toMatch(/designation/i)
  })

  it('NEW_SR_ID_MISMATCH when Sr differs from ID digits', () => {
    const p = plan([row({ 'Sr.': '7', 'Employee ID': 'TPLGOAMSN008' })])
    expect(p.skips[0].reason).toBe('NEW_SR_ID_MISMATCH')
  })

  it('leading zeros: Sr 007 matches ID ...007', () => {
    const p = plan([row({ 'Sr.': '007', 'Employee ID': 'TPLGOAMSN007' })])
    expect(p.creates).toHaveLength(1)
    expect(p.creates[0].serialNumber).toBe('007')
    expect(p.creates[0].number).toBe(7)
  })

  it('NEW_EMPLOYEE_ID_TAKEN when the ID string exists under another number', () => {
    // app employee has number null but same employeeId string cannot happen; use a differing-number app row with same ID string
    const taken = emp({ id: 'x', employeeId: 'TPLGOAMSN009', number: null })
    const p = plan([row({ 'Sr.': '9', 'Employee ID': 'TPLGOAMSN009' })], [taken])
    expect(p.skips[0].reason).toBe('NEW_EMPLOYEE_ID_TAKEN')
  })

  it('NEW_REQUIRED_INVALID lists every problem', () => {
    const p = plan([row({ 'Sr.': '3', 'Employee ID': 'TPLGOAMSN003', 'Employee Name': '', Designation: '', Salary: '4000/week', 'Date of Joining': 'X' })])
    expect(p.skips[0].reason).toBe('NEW_REQUIRED_INVALID')
    for (const label of ['Employee Name', 'Designation', 'Salary', 'Date of Joining']) {
      expect(p.skips[0].detail).toContain(label)
    }
  })

  it('joining exactly today+7 is allowed, +8 is JOINING_IN_FUTURE', () => {
    const ok = plan([row({ 'Sr.': '3', 'Employee ID': 'TPLGOAMSN003', 'Date of Joining': '01/12/2026' })])
    expect(ok.creates).toHaveLength(1)
    const bad = plan([row({ 'Sr.': '3', 'Employee ID': 'TPLGOAMSN003', 'Date of Joining': '02/12/2026' })])
    expect(bad.skips[0].reason).toBe('NEW_REQUIRED_INVALID')
    expect(bad.skips[0].detail).toContain('JOINING_IN_FUTURE')
  })

  it('EXISTING_REQUIRED_INVALID when name or designation blank; nothing updated', () => {
    const p = plan([row({ 'Employee Name': '' })], [emp()])
    expect(p.skips[0].reason).toBe('EXISTING_REQUIRED_INVALID')
    expect(p.updates).toHaveLength(0)
    expect(p.unchangedCount).toBe(0)
  })

  it('existing row with invalid salary and invalid joining date is NOT skipped', () => {
    const p = plan([row({ Salary: '4000/week', 'Date of Joining': 'junk', Site: 'North' })], [emp()])
    expect(p.skips).toHaveLength(0)
    expect(p.updates).toHaveLength(1)
    expect(p.updates[0].changes.map((c) => c.field)).toEqual(['site'])
  })
})

describe('planSync: creates', () => {
  it('creates a valid new employee; Active blank defaults to active', () => {
    const p = plan([row({ 'Sr.': '902', 'Employee ID': 'TPLGOADRV902', 'Employee Name': 'Joseph', Phone: '9446000001' })])
    expect(p.creates).toHaveLength(1)
    expect(p.creates[0]).toMatchObject({
      number: 902,
      employeeId: 'TPLGOADRV902',
      serialNumber: '902',
      salary: 800,
      isActive: true,
      wageEffectiveFrom: '2025-01-01',
    })
    expect(p.creates[0].fields.phone).toBe('9446000001')
  })

  it('Active=Inactive is respected on create', () => {
    const p = plan([row({ 'Sr.': '5', 'Employee ID': 'TPLGOAMSN005', Active: 'Inactive' })])
    expect(p.creates[0].isActive).toBe(false)
  })

  it('invalid Active on create becomes active with a field warning', () => {
    const p = plan([row({ 'Sr.': '5', 'Employee ID': 'TPLGOAMSN005', Active: 'Maybe' })])
    expect(p.creates[0].isActive).toBe(true)
    expect(p.warnings.some((w) => w.kind === 'FIELD' && w.warning.reason === 'INVALID_ACTIVE')).toBe(true)
  })
})

describe('planSync: updates', () => {
  it('no differences: no update, unchangedCount increments', () => {
    const p = plan([row()], [emp()])
    expect(p.updates).toHaveLength(0)
    expect(p.unchangedCount).toBe(1)
  })

  it('designation prefix change: ID unchanged, designation updated', () => {
    const p = plan([row({ 'Employee ID': 'TPLGOADRV001', Designation: 'DRIVER' })], [emp()])
    expect(p.updates[0].employeeId).toBe('TPLGOAMSN001')
    expect(p.updates[0].changes).toEqual([{ field: 'designation', old: 'MASON', new: 'DRIVER' }])
    expect(p.creates).toHaveLength(0)
  })

  it('existing employee with #N/A sheet ID still updates', () => {
    const p = plan([row({ 'Employee ID': '#N/A', Site: 'Goa' })], [emp()])
    expect(p.skips).toHaveLength(0)
    expect(p.updates[0].changes.map((c) => c.field)).toEqual(['site'])
  })

  it('blank sheet cell clears the app value', () => {
    const p = plan([row({ Phone: '' })], [emp({ fields: { phone: '9000000001' } })])
    expect(p.updates[0].changes).toEqual([{ field: 'phone', old: '9000000001', new: null }])
  })

  it('missing optional header never writes or clears', () => {
    const header = HEADER.filter((h) => h !== 'Phone')
    const r = HEADER.map((h, i) => row()[i]).filter((_, i) => HEADER[i] !== 'Phone')
    const p = plan([r], [emp({ fields: { phone: '9000000001' } })], header)
    expect(p.updates).toHaveLength(0)
    expect(p.unchangedCount).toBe(1)
  })

  it('invalid optional date leaves the field unchanged and warns', () => {
    const header = [...HEADER, 'D.O.B']
    const p = plan([[...row(), '31/02/1990']], [emp({ fields: { dateOfBirth: '1990-01-01' } })], header)
    expect(p.updates).toHaveLength(0)
    expect(p.warnings.some((w) => w.kind === 'FIELD' && w.warning.reason === 'INVALID_DATE')).toBe(true)
  })

  it('dateOfResignation comes from the sheet; isActive untouched', () => {
    const header = [...HEADER, 'Date of Resignation']
    const p = plan([[...row(), '10/11/2026']], [emp()], header)
    expect(p.updates[0].changes).toEqual([{ field: 'dateOfResignation', old: null, new: '2026-11-10' }])
    expect(p.warnings.filter((w) => w.kind === 'STATUS_MISMATCH')).toHaveLength(0)
  })

  it('never emits serialNumber, hourly rate or isActive as a change', () => {
    const p = plan([row({ Site: 'Z', Active: 'Inactive' })], [emp()])
    const fields = p.updates.flatMap((u) => u.changes.map((c) => c.field as string))
    expect(fields).not.toContain('serialNumber')
    expect(fields).not.toContain('isActive')
    expect(fields).not.toContain('hourlyRate')
  })
})

describe('planSync: warnings', () => {
  it('salary mismatch beyond 0.005 warns; within tolerance does not', () => {
    const w1 = plan([row({ Salary: '900' })], [emp()]).warnings
    expect(w1).toContainEqual({ kind: 'SALARY_MISMATCH', rowNumber: 2, employeeId: 'TPLGOAMSN001', sheet: 900, app: 800 })
    expect(plan([row({ Salary: '800.004' })], [emp()]).warnings).toHaveLength(0)
    expect(plan([row({ Salary: '800.006' })], [emp()]).warnings.some((w) => w.kind === 'SALARY_MISMATCH')).toBe(true)
  })

  it('no open wage gives app:null', () => {
    const w = plan([row()], [emp({ openWage: null })]).warnings
    expect(w[0]).toMatchObject({ kind: 'SALARY_MISMATCH', app: null, sheet: 800 })
  })

  it('invalid sheet salary on an existing row gives no mismatch warning', () => {
    const w = plan([row({ Salary: '4000/week' })], [emp()]).warnings
    expect(w).toHaveLength(0)
  })

  it('status mismatch warns; blank Active does not; app status never changed', () => {
    const mismatch = plan([row({ Active: 'Inactive' })], [emp({ isActive: true })])
    expect(mismatch.warnings).toContainEqual({ kind: 'STATUS_MISMATCH', rowNumber: 2, employeeId: 'TPLGOAMSN001', sheet: false, app: true })
    expect(plan([row({ Active: '' })], [emp()]).warnings).toHaveLength(0)
    expect(plan([row({ Active: 'Active' })], [emp()]).warnings).toHaveLength(0)
  })

  it('invalid Active on an existing row warns as a field warning', () => {
    const w = plan([row({ Active: 'Maybe' })], [emp()]).warnings
    expect(w.some((x) => x.kind === 'FIELD' && x.warning.reason === 'INVALID_ACTIVE')).toBe(true)
    expect(w.some((x) => x.kind === 'STATUS_MISMATCH')).toBe(false)
  })
})

describe('planSync: appOnly', () => {
  it('lists app employees absent from the sheet, including those with no number, never modified', () => {
    const test = emp({ id: 't', employeeId: 'TEST', employeeName: 'Test', number: null })
    const other = emp({ id: 'o', employeeId: 'TPLGOAMSN050', employeeName: 'Other', number: 50 })
    const p = plan([row()], [emp(), test, other])
    expect(p.appOnly.map((a) => a.employeeId)).toEqual(['TEST', 'TPLGOAMSN050'])
    expect(p.updates.map((u) => u.employeeDbId)).not.toContain('t')
  })

  it('an app employee whose number is on a skipped sheet row is not app-only', () => {
    const p = plan([row({ 'Employee Name': '' })], [emp()])
    expect(p.appOnly).toHaveLength(0)
  })
})

describe('hashPlan', () => {
  it('is a 64-char hex, stable across identical plans, independent of key order and counts', () => {
    const a = plan([row({ Site: 'A' })], [emp()])
    const b = plan([row({ Site: 'A' })], [emp()])
    expect(hashPlan(a)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashPlan(a)).toBe(hashPlan(b))
    const reordered = {
      appOnly: a.appOnly,
      warnings: a.warnings,
      skips: a.skips,
      updates: a.updates,
      creates: a.creates,
      unchangedCount: 999,
    }
    expect(hashPlan(reordered)).toBe(hashPlan(a))
  })

  it('changes when a change, a skip, a warning or an app-only entry changes', () => {
    const base = hashPlan(plan([row({ Site: 'A' })], [emp()]))
    expect(hashPlan(plan([row({ Site: 'B' })], [emp()]))).not.toBe(base)
    expect(hashPlan(plan([row({ Site: 'A', Salary: '999' })], [emp()]))).not.toBe(base)
    expect(hashPlan(plan([row({ Site: 'A' })], [emp(), emp({ id: 'z', employeeId: 'TEST', number: null })]))).not.toBe(base)
    expect(hashPlan(plan([row({ Site: 'A' }), row({ 'Sr.': 'XXX' })], [emp()]))).not.toBe(base)
  })
})
