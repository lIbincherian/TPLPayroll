export type AuditActionType =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'SYNC'
  | 'PULL'
  | 'APPROVE'
  | 'REOPEN'
  | 'DISCARD'

export type AuditEntityType =
  | 'EMPLOYEE'
  | 'WAGE_HISTORY'
  | 'ATTENDANCE_WEEK'
  | 'ATTENDANCE_PUNCH'
  | 'ATTENDANCE_DECISION'
  | 'ATTENDANCE_CODE'

export type AuditLogRecord = {
  id: string
  actionType: AuditActionType
  entityType: AuditEntityType
  entityId: string
  // Attendance entries may include `summary: string` for the viewer.
  detailsJson: Record<string, unknown>
  createdAt: Date
}

export type AuditLogListOptions = {
  entityType?: AuditEntityType
  actionType?: AuditActionType
  page?: number
  limit?: number
}

export type PaginatedAuditLogList = {
  logs: AuditLogRecord[]
  totalCount: number
  page: number
  limit: number
}
