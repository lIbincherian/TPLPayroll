import { NEW_PROFILE_FIELDS } from '@/features/employee-sheet-sync/lib/columns'

/** The profile fields the Employee Master sheet fills (F13), all empty. A new employee created in the app starts with these. */
export const EMPTY_SHEET_PROFILE = Object.fromEntries(NEW_PROFILE_FIELDS.map((field) => [field, null])) as {
  photoUrl: null
  aadhaarPhotoUrl: null
  panNumber: null
  panPhotoUrl: null
  whatsappNumber: null
  gPayName: null
  gPayRelation: null
  bankName: null
  bankHolderName: null
  bankHolderRelation: null
  ifscCode: null
  passbookPhotoUrl: null
  height: null
  bloodGroup: null
  emergencyContactName: null
  emergencyContactNumber: null
  emergencyContactRelation: null
  homeAddress: null
  homeState: null
  language: null
  relativesOnSite: null
  roomNumber: null
  distinctiveFeatures: null
  otherSkills: null
  remarks: null
}
