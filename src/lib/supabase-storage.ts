/**
 * supabase-storage.ts
 *
 * Server-side only. Thin wrapper around the Supabase Storage REST API
 * using the service role key — no SDK dependency.
 *
 * ⚠️  Never import this in client components or expose SUPABASE_SERVICE_ROLE_KEY
 *     to the browser.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const isMock = !process.env.SUPABASE_URL
const STORAGE_URL = isMock ? '' : `${process.env.SUPABASE_URL}/storage/v1`
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

function authHeader(): Record<string, string> {
  if (isMock) return {}
  return {
    Authorization: `Bearer ${SERVICE_KEY}`,
    apikey: SERVICE_KEY,
  }
}

// ─── Local Mock Helpers ───────────────────────────────────────────────────────

function getMockFilePath(bucket: string, storageKey: string) {
  return path.join(os.tmpdir(), 'tpl-payroll-mock-storage', bucket, storageKey)
}

// ─── createPresignedUploadUrl ─────────────────────────────────────────────────
// Returns a signed URL the browser can PUT the file to directly.
// The browser upload never touches Vercel — it goes straight to Supabase Storage.

export interface PresignedUploadUrl {
  signedUrl: string
  storageKey: string // path within the bucket, e.g. "documents/uuid_filename.pdf"
  token: string
}

export async function createPresignedUploadUrl(
  bucket: string,
  storageKey: string,
  expiresIn = 300 // seconds — 5 minutes is plenty for a direct browser PUT
): Promise<PresignedUploadUrl> {
  if (isMock) {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    return {
      signedUrl: `${baseUrl}/api/mock-storage/${bucket}/${storageKey}`,
      storageKey,
      token: 'mock-token',
    }
  }

  const res = await fetch(
    `${STORAGE_URL}/object/upload/sign/${bucket}/${storageKey}`,
    {
      method: 'POST',
      headers: {
        ...authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn }),
    }
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to create presigned upload URL: ${res.status} ${body}`)
  }

  const data = (await res.json()) as {
    url?: string
    signedURL?: string
    signedUrl?: string
    token?: string
  }

  const rawUrl = data.signedURL || data.signedUrl || data.url
  if (!rawUrl) {
    throw new Error('Supabase Storage API response did not contain a URL field.')
  }

  // Construct the absolute signed URL robustly
  let signedUrl = ''
  if (rawUrl.startsWith('http')) {
    signedUrl = rawUrl
  } else {
    // Supabase REST API may return a relative path that doesn't start with /storage/v1
    const relativePath = rawUrl.startsWith('/storage/v1')
      ? rawUrl
      : `/storage/v1${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`
    signedUrl = `${process.env.SUPABASE_URL}${relativePath}`
  }

  // Retrieve the token, fallback to extracting it from the query parameters of the URL if needed
  let token = data.token || ''
  if (!token) {
    try {
      const parsedUrl = new URL(signedUrl)
      token = parsedUrl.searchParams.get('token') || ''
    } catch (err) {
      console.error('[createPresignedUploadUrl] Failed to parse token from URL:', err)
    }
  }

  return { signedUrl, storageKey, token }
}

// ─── downloadFileAsBuffer ─────────────────────────────────────────────────────
// Server-side download of a file from Storage.

export async function downloadFileAsBuffer(
  bucket: string,
  storageKey: string
): Promise<Buffer> {
  if (isMock) {
    const filePath = getMockFilePath(bucket, storageKey)
    return fs.promises.readFile(filePath)
  }

  const res = await fetch(`${STORAGE_URL}/object/${bucket}/${storageKey}`, {
    headers: authHeader(),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `Failed to download file from Storage [${bucket}/${storageKey}]: ${res.status} ${body}`
    )
  }

  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// ─── deleteFile ───────────────────────────────────────────────────────────────
// Best-effort delete — logs but does not throw on failure.

export async function deleteFile(
  bucket: string,
  storageKey: string
): Promise<void> {
  if (isMock) {
    const filePath = getMockFilePath(bucket, storageKey)
    return fs.promises.unlink(filePath).catch(() => {})
  }

  const res = await fetch(`${STORAGE_URL}/object/${bucket}/${storageKey}`, {
    method: 'DELETE',
    headers: authHeader(),
  })

  if (!res.ok) {
    const body = await res.text()
    console.error(
      `[supabase-storage] Failed to delete [${bucket}/${storageKey}]: ${res.status} ${body}`
    )
  }
}

// ─── fileExists ───────────────────────────────────────────────────────────────
// HEAD request — check whether a key exists without downloading the file.

export async function fileExists(
  bucket: string,
  storageKey: string
): Promise<boolean> {
  if (isMock) {
    const filePath = getMockFilePath(bucket, storageKey)
    try {
      await fs.promises.access(filePath)
      return true
    } catch {
      return false
    }
  }

  const res = await fetch(`${STORAGE_URL}/object/info/${bucket}/${storageKey}`, {
    method: 'GET',
    headers: authHeader(),
  })
  return res.ok
}
