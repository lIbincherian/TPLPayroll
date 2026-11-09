// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  buildCreateReturnContext,
  buildEditReturnContext,
  employeeIdHintForCode,
  parseReturnTo,
} from '@/features/employee-management/lib/return-context'

// US-12.35 AC3 / spec §2.9: the attendance employee check opens /employees/new?returnTo=…&name=…&code=…
// and expects the user back there afterwards. Only in-app /attendance and /payroll paths are honoured.

const CHECK_PATH = '/attendance/2026-11-05/employee-check'

describe('parseReturnTo', () => {
  it.each([
    CHECK_PATH,
    '/attendance/2026-11-05/review',
    '/payroll/run/abc-123',
    '/payroll/generate/2026-11-05',
  ])('accepts the in-app path %s', (path) => {
    expect(parseReturnTo(path)).toBe(path)
  })

  it('takes the first value when the parameter is repeated', () => {
    expect(parseReturnTo([CHECK_PATH, 'https://evil.example/attendance/x'])).toBe(CHECK_PATH)
  })

  it.each([
    ['nothing', undefined],
    ['an empty string', ''],
    ['an empty list', []],
    ['another in-app section', '/employees'],
    ['the employee directory path', '/employees/123/edit'],
    ['a bare section with no sub-path', '/attendance'],
    ['a section prefix that only looks similar', '/attendance-sync/x'],
    ['a different letter case', '/Attendance/2026-11-05/employee-check'],
    ['an absolute external URL', 'https://evil.example/attendance/x'],
    ['an external URL that ends in an allowed path', 'https://evil.example/payroll/run/1'],
    ['a protocol-relative URL', '//evil.example/attendance/x'],
    ['a protocol-relative URL hidden after the section', '/attendance//evil.example'],
    ['a backslash path', '/attendance/x\\evil'],
    ['a backslash after the section', '/payroll\\evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a path with no leading slash', 'attendance/2026-11-05/employee-check'],
  ])('rejects %s', (_label, value) => {
    expect(parseReturnTo(value as never)).toBeUndefined()
  })
})

describe('employeeIdHintForCode', () => {
  it('says which digits the Employee ID must end in', () => {
    expect(employeeIdHintForCode('0999')).toBe('Employee ID must end in 999 to match code 0999')
  })

  it('reads all digits of a four-digit code', () => {
    expect(employeeIdHintForCode('1000')).toBe('Employee ID must end in 1000 to match code 1000')
  })

  it('drops leading zeros in the number but keeps the code as shown', () => {
    expect(employeeIdHintForCode('0001')).toBe('Employee ID must end in 1 to match code 0001')
  })

  it.each([undefined, '', 'A12', '12B', '0 9', '-5'])('gives no hint for %j', (code) => {
    expect(employeeIdHintForCode(code)).toBeUndefined()
  })
})

describe('buildCreateReturnContext', () => {
  it('builds the context from the params the employee check sends', () => {
    expect(buildCreateReturnContext({ returnTo: CHECK_PATH, name: 'Empname0999', code: '0999' })).toEqual({
      returnTo: CHECK_PATH,
      backLabel: 'Return to employee check',
      prefillName: 'Empname0999',
      employeeIdHint: 'Employee ID must end in 999 to match code 0999',
    })
  })

  it('returns to the exact path, with no query parameters added', () => {
    const context = buildCreateReturnContext({ returnTo: CHECK_PATH, name: 'Empname0999', code: '0999' })

    expect(context?.returnTo).toBe(CHECK_PATH)
    expect(context?.returnTo).not.toContain('?')
  })

  it('trims the name and drops a blank one', () => {
    expect(buildCreateReturnContext({ returnTo: CHECK_PATH, name: '  Empname0999  ' })?.prefillName).toBe('Empname0999')
    expect(buildCreateReturnContext({ returnTo: CHECK_PATH, name: '   ' })?.prefillName).toBeUndefined()
  })

  it('has no hint without a numeric code', () => {
    expect(buildCreateReturnContext({ returnTo: CHECK_PATH })?.employeeIdHint).toBeUndefined()
    expect(buildCreateReturnContext({ returnTo: CHECK_PATH, code: 'X9' })?.employeeIdHint).toBeUndefined()
  })

  it('is undefined, so the form behaves as before, with no returnTo', () => {
    expect(buildCreateReturnContext({})).toBeUndefined()
    expect(buildCreateReturnContext({ name: 'Empname0999', code: '0999' })).toBeUndefined()
  })

  it('ignores a returnTo that leaves the app, even with a name and code', () => {
    expect(buildCreateReturnContext({ returnTo: 'https://evil.example/attendance/x', name: 'A', code: '0999' })).toBeUndefined()
    expect(buildCreateReturnContext({ returnTo: '//evil.example/attendance/x' })).toBeUndefined()
    expect(buildCreateReturnContext({ returnTo: '/employees' })).toBeUndefined()
  })
})

describe('buildEditReturnContext', () => {
  it('builds a back link to the employee check', () => {
    expect(buildEditReturnContext({ returnTo: CHECK_PATH })).toEqual({ returnTo: CHECK_PATH, backLabel: 'Return to employee check' })
  })

  it('has nothing to prefill', () => {
    const context = buildEditReturnContext({ returnTo: CHECK_PATH })

    expect(context).not.toHaveProperty('prefillName')
    expect(context).not.toHaveProperty('employeeIdHint')
  })

  it('is undefined without a valid returnTo', () => {
    expect(buildEditReturnContext({})).toBeUndefined()
    expect(buildEditReturnContext({ returnTo: 'https://evil.example/payroll/run/1' })).toBeUndefined()
    expect(buildEditReturnContext({ returnTo: '/employees' })).toBeUndefined()
  })
})
