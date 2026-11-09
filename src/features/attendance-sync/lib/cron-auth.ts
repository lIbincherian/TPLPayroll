import { timingSafeEqual } from 'crypto'

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fails closed: an unset or
 * empty secret rejects every request.
 */
export function isAuthorizedCronRequest(request: Request, secret: string | undefined): boolean {
  if (!secret) return false

  const header = request.headers.get('authorization')
  if (!header) return false

  const expected = Buffer.from(`Bearer ${secret}`)
  const actual = Buffer.from(header)
  if (expected.length !== actual.length) return false

  return timingSafeEqual(expected, actual)
}
