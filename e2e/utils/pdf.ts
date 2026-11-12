import zlib from 'zlib'

// Minimal text extraction for the PDFs the app builds with pdfmake: standard fonts (Helvetica,
// Courier), Flate-compressed content streams, text shown with Tj / TJ as WinAnsi literal or hex
// strings. Enough to assert what a slip says; not a general PDF reader.

const WIN_ANSI_EXTRAS: Record<number, string> = {
  0x80: '€',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
}

function decodeBytes(bytes: number[]): string {
  return bytes.map((b) => (b === 0xa0 ? ' ' : (WIN_ANSI_EXTRAS[b] ?? String.fromCharCode(b)))).join('')
}

function decodeHex(hex: string): string {
  const clean = hex.replace(/\s+/g, '')
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16))
  return decodeBytes(bytes)
}

const BACKSLASH = String.fromCharCode(92)

function decodeLiteral(literal: string): string {
  const bytes: number[] = []
  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i]
    if (ch !== BACKSLASH) {
      bytes.push(ch.charCodeAt(0))
      continue
    }
    const next = literal[++i]
    if (next >= '0' && next <= '7') {
      let octal = next
      while (octal.length < 3 && literal[i + 1] >= '0' && literal[i + 1] <= '7') octal += literal[++i]
      bytes.push(parseInt(octal, 8))
    } else {
      const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 }
      bytes.push(map[next] ?? next.charCodeAt(0))
    }
  }
  return decodeBytes(bytes)
}

function inflateStreams(buffer: Buffer): string[] {
  const raw = buffer.toString('latin1')
  const streams: string[] = []
  const re = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw))) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    try {
      streams.push(zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'))
    } catch {
      // an image or a stream that is not Flate: no text in it
    }
    re.lastIndex = end
  }
  return streams
}

/** Every shown string of the document, one array element per text operator, in drawing order. */
export function extractPdfTextRuns(buffer: Buffer): string[] {
  const runs: string[] = []
  for (const content of inflateStreams(buffer)) {
    const operators = content.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|(<[0-9a-fA-F\s]*>|\((?:[^()\\]|\\.)*\))\s*Tj/g)
    for (const op of operators) {
      const source = op[1] ?? op[2]
      let text = ''
      for (const piece of source.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:[^()\\]|\\.)*)\)/g)) {
        text += piece[1] !== undefined ? decodeHex(piece[1]) : decodeLiteral(piece[2])
      }
      if (text.trim() !== '') runs.push(text)
    }
  }
  return runs
}

/** All text of the document, one run per line (non-breaking spaces read as spaces). */
export function extractPdfText(buffer: Buffer): string {
  return extractPdfTextRuns(buffer).join(String.fromCharCode(10))
}

/** All text on one line with single spaces: robust against where a cell was wrapped. */
export function extractPdfFlatText(buffer: Buffer): string {
  return extractPdfTextRuns(buffer).join(' ').replace(/\s+/g, ' ').trim()
}
