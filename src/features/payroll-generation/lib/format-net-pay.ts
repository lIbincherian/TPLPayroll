/**
 * Formats a net-pay amount with en-IN grouping. Net pay is rounded to the whole rupee, so a whole
 * amount shows no decimals (4513 → "4,513"); an older stored amount with paise keeps exactly two
 * decimals (4512.5 → "4,512.50") so the screen matches what was paid. No currency symbol.
 */
export function formatNetPay(amount: number): string {
  const whole = isWholeRupees(amount)
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount)
}

/** True when the amount, read to the paisa, has no paise. */
export function isWholeRupees(amount: number): boolean {
  return Number.isInteger(Math.round(amount * 100) / 100)
}
