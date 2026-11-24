import type { PlannedSkip, RowWarning, SheetOwnedField, SkipReason } from '../types/employee-sheet-sync.types'

// People-facing wording for the preview dialog and the status line.

export const FIELD_LABELS: Record<SheetOwnedField, string> = {
  employeeName: 'Name',
  designation: 'Designation',
  designationShort: 'Designation Short',
  dateOfJoining: 'Date of Joining',
  nationalId: 'National ID',
  aadhaarId: 'Aadhaar',
  policeVerificationId: 'Police Verification ID',
  phone: 'Phone',
  dateOfBirth: 'Date of Birth',
  healthCardId: 'Health Card',
  gPay: 'GPay',
  bankAccount: 'Bank Account',
  dateOfResignation: 'Date of Resignation',
  site: 'Site',
  photoUrl: 'Photo',
  aadhaarPhotoUrl: 'Aadhaar Photo',
  panNumber: 'PAN',
  panPhotoUrl: 'PAN Photo',
  whatsappNumber: 'WhatsApp',
  gPayName: 'GPay Name',
  gPayRelation: 'GPay Relation',
  bankName: 'Bank Name',
  bankHolderName: 'Bank Holder Name',
  bankHolderRelation: 'Bank Holder Relation',
  ifscCode: 'IFSC Code',
  passbookPhotoUrl: 'Passbook Photo',
  height: 'Height',
  bloodGroup: 'Blood Group',
  emergencyContactName: 'Emergency Contact Name',
  emergencyContactNumber: 'Emergency Contact Number',
  emergencyContactRelation: 'Emergency Contact Relation',
  homeAddress: 'Home Address',
  homeState: 'State',
  language: 'Language',
  relativesOnSite: 'Relatives on Site',
  roomNumber: 'Room Number',
  distinctiveFeatures: 'Distinctive Features',
  otherSkills: 'Other Skills',
  remarks: 'Remarks',
}

/** Fields whose values are links or bank and identity numbers: shown in the preview as "changed" only. */
export const MASKED_IN_PREVIEW: ReadonlySet<SheetOwnedField> = new Set<SheetOwnedField>([
  'panNumber',
  'bankAccount',
  'ifscCode',
  'aadhaarId',
  'photoUrl',
  'aadhaarPhotoUrl',
  'panPhotoUrl',
  'passbookPhotoUrl',
])

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  SR_INVALID: 'Sr. is blank or not a number',
  SR_DUPLICATE: 'Sr. is used on more than one row',
  AMBIGUOUS_APP_MATCH: 'The number matches more than one employee in the app',
  NEW_EMPLOYEE_ID_INVALID: 'New employee has no valid Employee ID (check the designation lookup in the sheet)',
  NEW_SR_ID_MISMATCH: "Sr. and the Employee ID's digits disagree",
  NEW_REQUIRED_INVALID: 'New employee is missing a valid name, designation, salary or joining date',
  EXISTING_REQUIRED_INVALID: 'Name or designation is blank, so the employee was left unchanged',
  NEW_EMPLOYEE_ID_TAKEN: 'That Employee ID already exists in the app',
}

export function describeSkip(skip: PlannedSkip): string {
  // The detail repeats the reason for these two, so the reason text alone is enough.
  if (!skip.detail || skip.reason === 'NEW_EMPLOYEE_ID_INVALID') return SKIP_REASON_TEXT[skip.reason]
  return `${SKIP_REASON_TEXT[skip.reason]}. ${skip.detail.replace('JOINING_IN_FUTURE: ', '')}`
}

export function describeWarning(warning: RowWarning): string {
  switch (warning.kind) {
    case 'SALARY_MISMATCH':
      return warning.app === null
        ? `Sheet salary ₹${warning.sheet}, the app has no current wage. Not changed.`
        : `Sheet salary ₹${warning.sheet}, app wage ₹${warning.app}. Not changed.`
    case 'STATUS_MISMATCH':
      return `Sheet says ${warning.sheet ? 'Active' : 'Inactive'}, the app says ${warning.app ? 'Active' : 'Inactive'}. Not changed.`
    case 'FIELD':
      return warning.warning.reason === 'INVALID_DATE'
        ? `${warning.warning.header}: "${warning.warning.raw}" is not a date (day first). Field left unchanged.`
        : `${warning.warning.header}: "${warning.warning.raw}" was not understood. ${warning.warning.reason === 'INVALID_ACTIVE' ? 'Active or Inactive expected.' : ''}`.trim()
  }
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function formatRunTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  })
}
