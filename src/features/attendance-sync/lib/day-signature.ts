import type { StoredPunchRow } from '../types/attendance-sync.types'

/** cyrb53: 53-bit string hash. A conflict token, not a security boundary. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * Order-independent version token of one employee-day's stored punches. Equal exactly when the rows
 * are the same with the same slots, sources, times and notes. null and '' differ. updatedAt and
 * mergedScansJson are left out.
 */
export function punchSetSignature(rows: ReadonlyArray<StoredPunchRow>): string {
  const tuples = rows
    .map((r) => [r.id, r.pairIndex, r.position, r.source, r.originalTime, r.currentTime, r.note] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return `${rows.length}.${hash53(JSON.stringify(tuples))}`
}
