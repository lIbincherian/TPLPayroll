import { describe, it, expect } from 'vitest'
import { formatNetPay } from '@/features/payroll-generation/lib/format-net-pay'

describe('formatNetPay', () => {
  it('shows a whole amount without decimals', () => {
    expect(formatNetPay(4513)).toBe('4,513')
  })

  it('shows an amount with paise with exactly two decimals', () => {
    expect(formatNetPay(4512.5)).toBe('4,512.50')
    expect(formatNetPay(1331.25)).toBe('1,331.25')
  })

  it('shows zero as 0', () => {
    expect(formatNetPay(0)).toBe('0')
  })

  it('uses Indian digit grouping', () => {
    expect(formatNetPay(145230)).toBe('1,45,230')
  })
})
