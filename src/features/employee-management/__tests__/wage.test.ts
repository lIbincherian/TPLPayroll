import { describe, it, expect } from 'vitest'
import { computeHourlyRate } from '../utils/wage'

describe('computeHourlyRate', () => {
  it.each([
    [800, 100],
    [1000, 125],
    [555, 69.38],
    [0, 0],
  ])('daily wage %d gives an hourly rate of %d', (dailyWage, hourlyRate) => {
    expect(computeHourlyRate(dailyWage)).toBe(hourlyRate)
  })
})
