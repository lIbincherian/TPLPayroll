import type { SheetOwnedField } from '../types/employee-sheet-sync.types'

// Sheet header → what it means. Headers are matched case-insensitively with whitespace collapsed (see normalizeHeader).

export type ColumnKind =
  | 'sr'
  | 'employeeId'
  | 'salary'
  | 'active'
  | 'text'
  | 'idText'
  | 'date'
  | 'whatsapp'

export type ColumnTarget =
  | { kind: 'sr' | 'employeeId' | 'salary' | 'active' }
  | { kind: 'text' | 'idText' | 'date' | 'whatsapp'; field: SheetOwnedField }

export interface ColumnDef {
  /** The header as the team writes it, used in messages. */
  header: string
  target: ColumnTarget
  /** Other spellings of the same header. */
  aliases?: string[]
}

export const COLUMNS: ColumnDef[] = [
  { header: 'Sr.', target: { kind: 'sr' } },
  { header: 'Employee ID', target: { kind: 'employeeId' } },
  { header: 'Salary', target: { kind: 'salary' } },
  { header: 'Active', target: { kind: 'active' } },
  { header: 'Employee Name', target: { kind: 'text', field: 'employeeName' } },
  { header: 'Designation', target: { kind: 'text', field: 'designation' } },
  { header: 'Designation Short', target: { kind: 'text', field: 'designationShort' } },
  { header: 'Date of Joining', target: { kind: 'date', field: 'dateOfJoining' } },
  { header: 'National ID', target: { kind: 'idText', field: 'nationalId' } },
  { header: 'Aadhaar Card', target: { kind: 'idText', field: 'aadhaarId' }, aliases: ['Aadhar Card'] },
  { header: 'Police Verification ID', target: { kind: 'idText', field: 'policeVerificationId' } },
  { header: 'Phone', target: { kind: 'idText', field: 'phone' } },
  { header: 'D.O.B', target: { kind: 'date', field: 'dateOfBirth' } },
  { header: 'Health Card', target: { kind: 'idText', field: 'healthCardId' } },
  { header: 'GPay', target: { kind: 'idText', field: 'gPay' } },
  { header: 'Bank Account No.', target: { kind: 'idText', field: 'bankAccount' } },
  { header: 'Date of Resignation', target: { kind: 'date', field: 'dateOfResignation' } },
  { header: 'Site', target: { kind: 'text', field: 'site' } },
  { header: 'Photo', target: { kind: 'text', field: 'photoUrl' } },
  { header: 'Aadhar Card Photo', target: { kind: 'text', field: 'aadhaarPhotoUrl' }, aliases: ['Aadhaar Card Photo'] },
  { header: 'PAN Card', target: { kind: 'idText', field: 'panNumber' } },
  { header: 'PAN Card Photo', target: { kind: 'text', field: 'panPhotoUrl' } },
  { header: 'WhatsApp', target: { kind: 'whatsapp', field: 'whatsappNumber' } },
  { header: 'GPay Name', target: { kind: 'text', field: 'gPayName' } },
  { header: 'GPay Relation', target: { kind: 'text', field: 'gPayRelation' } },
  { header: 'Bank Name', target: { kind: 'text', field: 'bankName' } },
  { header: 'Bank Holder Name', target: { kind: 'text', field: 'bankHolderName' } },
  { header: 'Bank Holder Relation', target: { kind: 'text', field: 'bankHolderRelation' } },
  { header: 'IFSC Code', target: { kind: 'idText', field: 'ifscCode' } },
  { header: 'Passbook Photo', target: { kind: 'text', field: 'passbookPhotoUrl' } },
  { header: 'Height', target: { kind: 'text', field: 'height' } },
  { header: 'Blood Group', target: { kind: 'text', field: 'bloodGroup' } },
  { header: 'Emergency Contact Name', target: { kind: 'text', field: 'emergencyContactName' } },
  { header: 'Emergency Contact No.', target: { kind: 'idText', field: 'emergencyContactNumber' } },
  { header: 'Emergency Contact Relation', target: { kind: 'text', field: 'emergencyContactRelation' } },
  { header: 'Home Address (Aadhar)', target: { kind: 'text', field: 'homeAddress' }, aliases: ['Home Address (Aadhaar)'] },
  { header: 'State', target: { kind: 'text', field: 'homeState' } },
  { header: 'Language', target: { kind: 'text', field: 'language' } },
  { header: 'Relatives on Site?', target: { kind: 'text', field: 'relativesOnSite' } },
  { header: 'Room No. & Bldg No.', target: { kind: 'text', field: 'roomNumber' } },
  { header: 'Distinctive Features', target: { kind: 'text', field: 'distinctiveFeatures' } },
  { header: 'Other Skills', target: { kind: 'text', field: 'otherSkills' } },
  { header: 'Remarks', target: { kind: 'text', field: 'remarks' } },
]

/** A missing required header fails the whole run. */
export const REQUIRED_HEADERS = [
  'Sr.',
  'Employee ID',
  'Employee Name',
  'Designation',
  'Salary',
  'Date of Joining',
] as const

/** Fields the sheet overwrites on every sync (everything but Employee ID, Salary and Active). */
export const SHEET_OWNED_FIELDS: SheetOwnedField[] = COLUMNS.flatMap((c) =>
  'field' in c.target ? [c.target.field] : [],
)

/** The 25 profile fields the app did not store before F13. */
export const NEW_PROFILE_FIELDS: SheetOwnedField[] = [
  'photoUrl',
  'aadhaarPhotoUrl',
  'panNumber',
  'panPhotoUrl',
  'whatsappNumber',
  'gPayName',
  'gPayRelation',
  'bankName',
  'bankHolderName',
  'bankHolderRelation',
  'ifscCode',
  'passbookPhotoUrl',
  'height',
  'bloodGroup',
  'emergencyContactName',
  'emergencyContactNumber',
  'emergencyContactRelation',
  'homeAddress',
  'homeState',
  'language',
  'relativesOnSite',
  'roomNumber',
  'distinctiveFeatures',
  'otherSkills',
  'remarks',
]

/** Fields that hold a date ('YYYY-MM-DD' in plans, UTC midnight in the database). */
export const DATE_FIELDS: ReadonlySet<SheetOwnedField> = new Set<SheetOwnedField>([
  'dateOfJoining',
  'dateOfBirth',
  'dateOfResignation',
])

/** Lower case, whitespace collapsed and trimmed: "  Employee   ID " → "employee id". */
export function normalizeHeader(header: string): string {
  return header.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** normalized header → column. */
export const COLUMN_BY_HEADER: ReadonlyMap<string, ColumnDef> = new Map(
  COLUMNS.flatMap((c) => [c.header, ...(c.aliases ?? [])].map((h) => [normalizeHeader(h), c] as const)),
)
