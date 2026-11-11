import { notFound } from 'next/navigation'
import { AppShell } from '@/components/layout/AppShell'
import { AttendancePreviewClient } from '@/features/attendance-upload/components/AttendancePreviewClient'
import { getAttendanceUploadPreviewAction } from '@/features/attendance-upload/actions/attendance.actions'
import prisma from '@/lib/prisma'
import type { Metadata } from 'next'

export const dynamic = 'force-dynamic'


interface Props {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  return { title: `Attendance Preview ${id} — TPL Payroll` }
}

export default async function AttendancePreviewPage({ params }: Props) {
  const { id } = await params
  const result = await getAttendanceUploadPreviewAction(id)

  if (!result.ok) notFound()

  const { data } = result
  const { upload, records } = data

  const total = records.length
  const matched = records.filter((r) => {
    const status = r.matchStatus
    const decision = r.verificationDecision
    return (
      status === 'MATCHED' ||
      status === 'MANUALLY_MATCHED' ||
      ((status === 'INACTIVE' || status === 'RESIGNED_BEFORE_WEEK') && decision === 'APPROVED')
    )
  }).length
  const unmatched = records.filter((r) => r.matchStatus === 'UNMATCHED').length
  const excluded = records.filter((r) => {
    const status = r.matchStatus
    if (status === 'REJECTED_UNMATCHED') return true
    return (
      (status === 'INACTIVE' || status === 'RESIGNED_BEFORE_WEEK') &&
      r.verificationDecision === 'REJECTED'
    )
  }).length

  // Determine blocking status from the upload record
  const uploadRecord = await prisma.attendanceUpload.findUnique({
    where: { id },
    select: { status: true },
  })

  const actuallyBlocked = uploadRecord?.status !== 'READY'

  return (
    <AppShell>
      <AttendancePreviewClient
        data={data}
        isBlocked={actuallyBlocked}
        total={total}
        matched={matched}
        unmatched={unmatched}
        excluded={excluded}
        records={records}
      />
    </AppShell>
  )
}
