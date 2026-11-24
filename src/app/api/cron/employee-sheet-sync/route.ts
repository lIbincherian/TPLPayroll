import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCronRequest } from '@/features/attendance-sync/lib/cron-auth'
import { runScheduledSheetSync } from '@/features/employee-sheet-sync/services/sync.service'
import { SheetSyncError } from '@/features/employee-sheet-sync/types/employee-sheet-sync.types'

export const dynamic = 'force-dynamic'
// 30 s sheet read + 60 s write transaction + reads.
export const maxDuration = 120

// Vercel Cron calls this with `Authorization: Bearer <CRON_SECRET>` (see vercel.json).
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const outcome = await runScheduledSheetSync()
    return NextResponse.json({ ok: true, ...outcome })
  } catch (error) {
    // 200 so Vercel doesn't retry-storm; the failure is saved as a FAILED run.
    const code = error instanceof SheetSyncError ? error.code : 'UNEXPECTED'
    if (!(error instanceof SheetSyncError)) console.error('[EmployeeSheetSyncCron] Unexpected error:', error)
    return NextResponse.json({ ok: false, error: code }, { status: 200 })
  }
}
