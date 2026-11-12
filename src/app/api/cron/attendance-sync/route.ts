import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCronRequest } from '@/features/attendance-sync/lib/cron-auth'
import { runScheduledSync } from '@/features/attendance-sync/services/sync.service'
import { AttendanceSyncError } from '@/features/attendance-sync/types/attendance-sync.types'

export const dynamic = 'force-dynamic'
// 45 s API timeout + 30 s save transaction + reads; must stay under SYNC_LOCK_TTL_MS (300 s) so a
// running pull never loses its lock, and under the Vercel Hobby cap (300 s with Fluid compute).
export const maxDuration = 120

// Vercel Cron calls this with `Authorization: Bearer <CRON_SECRET>` (see vercel.json).
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const outcome = await runScheduledSync()
    return NextResponse.json({ ok: true, ...outcome })
  } catch (error) {
    // 200 so Vercel doesn't retry-storm; the failure is recorded on the week itself.
    const code = error instanceof AttendanceSyncError ? error.code : 'UNEXPECTED'
    if (!(error instanceof AttendanceSyncError)) console.error('[AttendanceCron] Unexpected error:', error)
    return NextResponse.json({ ok: false, error: code }, { status: 200 })
  }
}
