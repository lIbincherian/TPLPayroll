// Hours in a working day; the stored daily wage covers this many hours.
const HOURS_PER_DAY = 8

export function computeHourlyRate(dailyWage: number): number {
  return Math.round((dailyWage / HOURS_PER_DAY) * 100) / 100
}
