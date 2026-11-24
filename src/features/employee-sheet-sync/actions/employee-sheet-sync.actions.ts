'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import {
  SheetSyncError,
  type ActionResult,
  type ApplySheetSyncResult,
  type LastSheetSync,
  type SheetSyncPreview,
} from '../types/employee-sheet-sync.types'
import { applySheetSync, getLastSheetSync, previewSheetSync } from '../services/sync.service'

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data }
}

function err(error: string, code?: string): ActionResult<never> {
  return { ok: false, error, code }
}

// The messages on SheetSyncError are written for people and carry no secrets, so they pass through.
function handleError(e: unknown): ActionResult<never> {
  if (e instanceof SheetSyncError) return err(e.message, e.code)
  console.error('[EmployeeSheetSyncAction]', e)
  return err('An unexpected error occurred. Nothing was changed.')
}

const applySchema = z.object({ planHash: z.string().regex(/^[a-f0-9]{64}$/) })

/** Reads the sheet and returns what Apply would write. Writes nothing. */
export async function previewSheetSyncAction(): Promise<ActionResult<SheetSyncPreview>> {
  try {
    return ok(await previewSheetSync())
  } catch (e) {
    return handleError(e)
  }
}

/** Applies the previewed plan. STALE means the sheet or the app changed since the preview: nothing was written. */
export async function applySheetSyncAction(input: {
  planHash: string
}): Promise<ActionResult<ApplySheetSyncResult>> {
  const parsed = applySchema.safeParse(input)
  if (!parsed.success) return err('The request was not valid.', 'VALIDATION_ERROR')

  try {
    const result = await applySheetSync(parsed.data.planHash)
    if (result.status === 'APPLIED') revalidatePath('/employees')
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}

export async function getLastSheetSyncAction(): Promise<ActionResult<LastSheetSync | null>> {
  try {
    return ok(await getLastSheetSync())
  } catch (e) {
    return handleError(e)
  }
}
