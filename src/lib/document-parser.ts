/**
 * document-parser — extract plain text from an uploaded knowledge document.
 *
 * Used by POST /api/ai/knowledge/document (routes/ai-responder.ts). The bot's
 * knowledge base stores plain text chunks, so a PDF/DOCX/TXT upload is parsed
 * to text here, then handed to chunkText()/insertChunks().
 *
 * Supported (by extension + MIME, extension wins when both present):
 *   - .pdf                              → unpdf (pdf.js, pure-JS, serverless-safe)
 *   - .docx                             → mammoth (raw text extraction)
 *   - .txt .md .markdown .csv .text     → utf-8 decode
 *
 * .doc (legacy binary Word) is NOT supported — mammoth only reads the modern
 * OOXML .docx. We surface a clear error so the user re-saves as .docx/PDF
 * rather than silently ingesting binary garbage.
 *
 * Everything is best-effort and defensive: a parse failure throws a typed
 * Error with a user-facing message; the route turns it into a 422.
 */

export interface ParsedDocument {
  text:    string
  kind:    'pdf' | 'docx' | 'text'
  pages?:  number
}

export class UnsupportedDocumentError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedDocumentError' }
}

const TEXT_EXTS = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'log', 'json'])

function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec((filename || '').trim())
  return m ? m[1].toLowerCase() : ''
}

/** Collapse the runaway whitespace PDF/DOCX extractors emit. */
function normalize(text: string): string {
  return (text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(l => l.trim()).join('\n')
    .trim()
}

async function parsePdf(buf: Buffer): Promise<ParsedDocument> {
  // unpdf is ESM-only — dynamic import keeps this CJS module loading.
  const { getDocumentProxy, extractText } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { totalPages, text } = await extractText(pdf, { mergePages: true })
  const merged = Array.isArray(text) ? text.join('\n\n') : text
  return { text: normalize(merged), kind: 'pdf', pages: totalPages }
}

async function parseDocx(buf: Buffer): Promise<ParsedDocument> {
  const mammoth = await import('mammoth')
  const fn = (mammoth as any).extractRawText ?? (mammoth as any).default?.extractRawText
  const { value } = await fn({ buffer: buf })
  return { text: normalize(value), kind: 'docx' }
}

function parseText(buf: Buffer): ParsedDocument {
  return { text: normalize(buf.toString('utf-8')), kind: 'text' }
}

/**
 * Parse an uploaded file buffer into plain text.
 * @throws UnsupportedDocumentError for unknown / legacy formats.
 */
export async function parseDocument(
  buf: Buffer,
  filename: string,
  mimetype?: string,
): Promise<ParsedDocument> {
  if (!buf || buf.length === 0) throw new UnsupportedDocumentError('The file is empty.')
  const ext = extOf(filename)
  const mime = (mimetype || '').toLowerCase()

  // PDF
  if (ext === 'pdf' || mime === 'application/pdf') return parsePdf(buf)

  // Modern Word (.docx)
  if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return parseDocx(buf)
  }

  // Legacy binary Word (.doc) — unsupported, fail loudly.
  if (ext === 'doc' || mime === 'application/msword') {
    throw new UnsupportedDocumentError(
      'Legacy .doc files aren’t supported. Please re-save as .docx or export to PDF and upload again.',
    )
  }

  // Plain-text family
  if (TEXT_EXTS.has(ext) || mime.startsWith('text/') || mime === 'application/json') {
    return parseText(buf)
  }

  // Unknown extension but text-looking MIME → try text; else reject.
  if (!ext && mime.startsWith('text/')) return parseText(buf)

  throw new UnsupportedDocumentError(
    `Unsupported file type${ext ? ` (.${ext})` : ''}. Upload a PDF, DOCX, TXT, MD, or CSV file.`,
  )
}
