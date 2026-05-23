/**
 * Worker: signed-form.pdf (BullMQ event-driven, Block D)
 *
 * Renders a PDF receipt for every signed form submission and uploads
 * it to the form-uploads Supabase Storage bucket. Triggered by an
 * enqueue from routes/forms.ts when a submitted form has a signature
 * field.
 *
 * PDF contents:
 *   - Form title + branding header
 *   - Every form field's label + submitted value (skips fields whose
 *     show_if evaluated to hidden — those values aren't in response_data)
 *   - The decoded signature image (embedded from base64 PNG)
 *   - Audit footer: signed_at · signer ip-hash (truncated) · user_agent
 *     (truncated) · document_hash (sha256 of schema_json at submit)
 *
 * On success, writes form_submissions.pdf_path + flips pdf_status to
 * 'rendered'. On error, sets pdf_status='failed' + pdf_error so it
 * surfaces in the Submissions tab.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import PDFDocument from 'pdfkit'
import { Q, connection, type SignedFormPdfJob } from '../queue'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const BUCKET = 'form-uploads'

export function startSignedFormPdfWorker() {
  const worker = new Worker<SignedFormPdfJob>(
    Q.signedFormPdf,
    async (job: Job<SignedFormPdfJob>) => {
      const { submissionId } = job.data
      if (!submissionId) return { skipped: 'no submission id' }

      // Load the submission + the form (for schema + title).
      const { data: sub, error: subErr } = await supabase
        .from('form_submissions')
        .select('id, form_id, tenant_id, response_data, signer_name, signed_at, ip_hash, user_agent, document_hash')
        .eq('id', submissionId)
        .maybeSingle()
      if (subErr) throw new Error(`load submission: ${subErr.message}`)
      if (!sub)   return { skipped: `submission ${submissionId} not found` }

      const { data: form, error: formErr } = await supabase
        .from('form_pages')
        .select('id, slug, title, schema_json, tenant_id')
        .eq('id', (sub as any).form_id)
        .maybeSingle()
      if (formErr) throw new Error(`load form: ${formErr.message}`)
      if (!form)   throw new Error(`form not found for submission ${submissionId}`)

      // Render PDF to a Buffer in-memory. pdfkit streams chunks; we
      // collect them into a single Buffer for the Storage upload.
      const pdfBytes = await renderSignedPdf({
        title:         (form as any).title,
        schema:        (form as any).schema_json,
        responseData:  ((sub as any).response_data ?? {}) as Record<string, unknown>,
        signerName:    (sub as any).signer_name,
        signedAt:      (sub as any).signed_at,
        ipHash:        (sub as any).ip_hash,
        userAgent:     (sub as any).user_agent,
        documentHash:  (sub as any).document_hash,
      })

      // Upload to form-uploads/signed/<tenant>/<form>/<submission>.pdf
      const path = `signed/${(sub as any).tenant_id}/${(sub as any).form_id}/${submissionId}.pdf`
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, pdfBytes, {
          contentType: 'application/pdf',
          upsert:      true,  // idempotent re-renders overwrite the existing path
        })
      if (upErr) throw new Error(`storage upload: ${upErr.message}`)

      // Mark the submission rendered.
      await supabase.from('form_submissions')
        .update({ pdf_path: path, pdf_status: 'rendered', pdf_error: null })
        .eq('id', submissionId)

      return { submissionId, path, bytes: pdfBytes.length }
    },
    { connection, concurrency: 4 },
  )

  worker.on('failed', async (job, err) => {
    const id = job?.data?.submissionId
    if (!id) return
    console.warn(`[signed-form-pdf] render failed for ${id}: ${err.message}`)
    try {
      await supabase.from('form_submissions')
        .update({ pdf_status: 'failed', pdf_error: err.message.slice(0, 500) })
        .eq('id', id)
    } catch {
      /* best-effort: don't crash the failure handler */
    }
  })

  console.log('[worker:signed-form-pdf] started')
  return worker
}

// ── PDF rendering ───────────────────────────────────────────────────────

interface RenderInput {
  title:         string
  schema:        any
  responseData:  Record<string, unknown>
  signerName:    string | null
  signedAt:      string | null
  ipHash:        string | null
  userAgent:     string | null
  documentHash:  string | null
}

function renderSignedPdf(input: RenderInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // ── Header ──
      doc.fontSize(20).fillColor('#111').text(input.title || 'Signed form', { align: 'left' })
      doc.moveDown(0.25)
      doc.fontSize(10).fillColor('#666').text('Form submission receipt', { align: 'left' })
      doc.moveDown(1)
      doc.strokeColor('#e5e7eb').lineWidth(0.5)
         .moveTo(50, doc.y).lineTo(545, doc.y).stroke()
      doc.moveDown(0.75)

      // ── Field values ──
      doc.fontSize(11).fillColor('#111').text('Submission details', { underline: false })
      doc.moveDown(0.5)
      doc.fontSize(9).fillColor('#333')

      let signatureDataUrl: string | null = null
      for (const w of (input.schema?.widgets ?? []) as any[]) {
        if (w?.kind !== 'form' || !Array.isArray(w.fields)) continue
        for (const f of w.fields as any[]) {
          const value = input.responseData[f.id]
          if (value === undefined || value === null || value === '') continue
          if (f.kind === 'signature' && typeof value === 'string' && value.startsWith('data:image')) {
            // Pull the signature out for separate handling below.
            signatureDataUrl = value
            continue
          }
          doc.font('Helvetica-Bold').text(`${f.label}: `, { continued: true })
             .font('Helvetica').text(String(value))
          doc.moveDown(0.25)
        }
      }

      doc.moveDown(0.75)

      // ── Signature image ──
      if (signatureDataUrl) {
        doc.strokeColor('#e5e7eb').lineWidth(0.5)
           .moveTo(50, doc.y).lineTo(545, doc.y).stroke()
        doc.moveDown(0.5)
        doc.fontSize(11).fillColor('#111').text('Signature', { align: 'left' })
        doc.moveDown(0.5)

        try {
          // Strip the "data:image/png;base64," prefix and decode.
          const b64 = signatureDataUrl.replace(/^data:image\/[a-z]+;base64,/, '')
          const sigBuf = Buffer.from(b64, 'base64')
          // Cap width at 300px so it doesn't push past page boundaries.
          doc.image(sigBuf, { width: 300 })
        } catch {
          doc.fontSize(9).fillColor('#999').text('(signature could not be rendered)')
        }
        doc.moveDown(1)
      }

      // ── Audit footer ──
      doc.strokeColor('#e5e7eb').lineWidth(0.5)
         .moveTo(50, doc.y).lineTo(545, doc.y).stroke()
      doc.moveDown(0.5)
      doc.fontSize(8).fillColor('#999')
      const auditLines: string[] = []
      if (input.signerName) auditLines.push(`Signer: ${input.signerName}`)
      if (input.signedAt)   auditLines.push(`Signed at: ${new Date(input.signedAt).toISOString()}`)
      if (input.ipHash)     auditLines.push(`Signer IP hash: ${input.ipHash.slice(0, 16)}…`)
      if (input.userAgent)  auditLines.push(`User agent: ${input.userAgent.slice(0, 100)}`)
      if (input.documentHash) auditLines.push(`Document hash (sha256): ${input.documentHash.slice(0, 32)}…`)
      auditLines.push(`Receipt rendered: ${new Date().toISOString()}`)
      for (const line of auditLines) doc.text(line)

      doc.end()
    } catch (err) {
      reject(err as Error)
    }
  })
}
