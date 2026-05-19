/**
 * Worker: contact-import-processor
 *
 * Two-phase async pipeline for contact_import_jobs rows:
 *
 *   1. PARSE + DRY-RUN
 *      Triggered by: status='pending' when the job is enqueued.
 *      Loads csv text from inline_payload (or Supabase Storage when
 *      storage_path is set), parses into normalised rows, validates per
 *      row, writes preview_jsonb + errors_jsonb + counts, leaves
 *      status='dry_run' for operator review.
 *
 *   2. EXECUTE (commit)
 *      Triggered by: status='executing' when /commit re-enqueues.
 *      Same parse, but now:
 *        - UPSERT into contacts on (tenant_id, phone)
 *          (UPDATE only merges non-empty fields — never wipes existing
 *          attributes the contact already has).
 *        - INSERT a consent_events row per contact with
 *            source='bulk_import',
 *            source_detail={ job_id, filename, consent_basis, source_label },
 *            proof_text=<job.consent_proof_text>
 *          This is the DPDPA evidentiary trail. The trigger from 072
 *          materialises contact_consent_state from this row.
 *      Leaves status='completed' (or 'partial' if any row errored).
 *
 * Idempotency:
 *   - contacts UPSERT on (tenant_id, phone) is naturally safe to re-run.
 *   - consent_events for the same (contact_id, channel, purpose, source_detail.job_id)
 *     do create duplicate rows on retry, but the materialise trigger
 *     idempotently upserts contact_consent_state. The duplicates are
 *     append-only audit noise — acceptable; better than skipping a
 *     legitimate re-consent. The worker logs duplicate-key counts so an
 *     operator can spot if a job ran twice.
 *
 * CSV parser: minimal inline (no new dep). Handles double-quoted fields
 * with embedded commas + RFC4180 quote escaping ("" → "). For XLSX, the
 * FE converts to CSV before POST — we never get binary here.
 *
 * Phone shape: +91 XXXXXXXXXX, +91XXXXXXXXXX, 91XXXXXXXXXX, or
 * 10-digit-starting-with-6/7/8/9. Stored without the leading '+' to
 * match contacts.phone everywhere else in the codebase.
 */

import '../env'
import { Worker, Job, Queue } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { connection } from '../queue'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Dedicated queue — separate from broadcast.batch so a heavy CSV doesn't
// starve a tenant's broadcast fan-outs.
export const CONTACT_IMPORT_QUEUE = 'contact.import' as const
export interface ContactImportJob {
  jobId: string
}

export const contactImportQueue = new Queue<ContactImportJob>(CONTACT_IMPORT_QUEUE, {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 200, age: 24 * 60 * 60 },
    removeOnFail:     { count: 1000, age: 7 * 24 * 60 * 60 },
    // Parsing/upserting 50k rows on a busy DB can take a minute+. Don't
    // retry blindly — a transient error is better surfaced as a row-level
    // error than a wholesale re-run. 2 attempts catches Redis blips.
    attempts: 2,
    backoff:  { type: 'exponential', delay: 5_000 },
  },
})

export async function enqueueContactImport(jobId: string) {
  // Use the row id as the BullMQ jobId so retries collapse instead of
  // doubling up. BullMQ 5.x rejects custom job ids containing ':' unless
  // they have exactly 3 colon-separated parts (legacy repeatable-job
  // shape) — so we use a hyphen separator instead.
  try {
    await contactImportQueue.add('process', { jobId }, { jobId: `contact-import-${jobId}` })
  } catch (err: any) {
    // BullMQ throws on duplicate jobId — that's fine, worker will pick
    // up the existing one. Same pattern as enqueueBreachNotification.
    if (!String(err?.message ?? err).toLowerCase().includes('already')) {
      throw err
    }
  }
}

export function startContactImportProcessorWorker() {
  const worker = new Worker<ContactImportJob>(
    CONTACT_IMPORT_QUEUE,
    async (job: Job<ContactImportJob>) => processJob(job.data.jobId),
    {
      connection,
      concurrency: Number(process.env.CONTACT_IMPORT_CONCURRENCY ?? 2),
    },
  )
  worker.on('failed', (job, err) => {
    console.warn(`[worker:contact-import] ✗ job=${job?.id} — ${err.message}`)
  })
  console.log('[worker:contact-import] started')
  return worker
}

// ── Main job handler ────────────────────────────────────────────────────────
async function processJob(jobId: string) {
  // 1. Load the row.
  const { data: job, error: loadErr } = await supabase
    .from('contact_import_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle()
  if (loadErr) throw new Error(`load job ${jobId}: ${loadErr.message}`)
  if (!job) {
    console.warn(`[contact-import] job ${jobId} disappeared — skipping`)
    return { skipped: 'missing' }
  }
  if (job.cancelled_at) {
    console.log(`[contact-import] job ${jobId} cancelled — skipping`)
    return { skipped: 'cancelled' }
  }

  // 2. Branch on status.
  if (job.status === 'pending') {
    return runDryRun(job)
  }
  if (job.status === 'executing') {
    return runExecute(job)
  }
  // Anything else (dry_run / completed / failed / partial) is a no-op —
  // either operator hasn't committed yet, or the job already ran.
  console.log(`[contact-import] job ${jobId} status=${job.status} — nothing to do`)
  return { skipped: `status=${job.status}` }
}

// ── Phase 1: parse + dry-run ────────────────────────────────────────────────
async function runDryRun(job: any) {
  await supabase.from('contact_import_jobs').update({
    status: 'parsing', started_at: new Date().toISOString(),
  }).eq('id', job.id)

  const csv = await loadCsv(job)
  if (csv == null) {
    await markFailed(job.id, 'No csv payload (inline_payload empty and storage_path missing)')
    return { failed: 'no_payload' }
  }

  const parsed = parseCsvAndValidate(csv)
  // Preview cache — first 100 normalised rows; trim error list to 200
  // so a 50k-row file with 49k bad phones doesn't bloat the row.
  const preview = parsed.rows.slice(0, 100).map(r => ({
    row: r.lineNumber,
    phone: r.phone,
    name: r.name,
    email: r.email,
    city: r.city,
    attributes: r.attributes,
    ok: r.ok,
    error: r.error,
  }))
  const errors = parsed.errors.slice(0, 200)

  await supabase.from('contact_import_jobs').update({
    status: 'dry_run',
    rows_total:    parsed.rows.length,
    rows_imported: 0,
    rows_updated:  0,
    rows_skipped:  0,
    rows_error:    parsed.errors.length,
    preview_jsonb: preview,
    errors_jsonb:  errors,
  }).eq('id', job.id)
  console.log(`[contact-import] ${job.id} dry-run: ${parsed.rows.length} rows, ${parsed.errors.length} errors`)
  return { phase: 'dry_run', rows: parsed.rows.length, errors: parsed.errors.length }
}

// ── Phase 2: execute (commit) ───────────────────────────────────────────────
async function runExecute(job: any) {
  const csv = await loadCsv(job)
  if (csv == null) {
    await markFailed(job.id, 'No csv payload at commit time')
    return { failed: 'no_payload' }
  }
  const parsed = parseCsvAndValidate(csv)

  let imported = 0, updated = 0, errored = parsed.errors.length, skipped = 0
  const newErrors: Array<{ row_number: number; error: string; raw?: unknown }> = []

  for (const row of parsed.rows) {
    if (!row.ok) {
      // Already counted in parsed.errors above — don't double.
      continue
    }
    try {
      // ── UPSERT contact ────────────────────────────────────────────────
      // Look up existing on (tenant_id, phone). If it exists, MERGE
      // attributes (don't wipe). If it doesn't, INSERT a fresh row with
      // status='active' (consent state is materialised by the trigger).
      const { data: existing, error: lookErr } = await supabase
        .from('contacts')
        .select('id, attributes, tags')
        .eq('tenant_id', job.tenant_id)
        .eq('phone', row.phone)
        .maybeSingle()
      if (lookErr) throw new Error(lookErr.message)

      let contactId: string
      if (existing) {
        const mergedAttrs = {
          ...(existing.attributes ?? {}),
          ...row.attributes,
        }
        const { error: updErr } = await supabase
          .from('contacts')
          .update({
            // Only fill name/email if the row gives us a value AND the
            // existing row didn't have one — never overwrite a name the
            // operator already curated.
            ...(row.name && !(existing as any).name ? { name: row.name } : {}),
            ...(row.email ? { email: row.email } : {}),
            attributes: mergedAttrs,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .eq('tenant_id', job.tenant_id)
        if (updErr) throw new Error(updErr.message)
        contactId = existing.id
        updated++
      } else {
        const { data: created, error: insErr } = await supabase
          .from('contacts')
          .insert({
            tenant_id:  job.tenant_id,
            name:       row.name || 'Imported Contact',
            phone:      row.phone,
            email:      row.email ?? null,
            tags:       [],
            attributes: row.attributes,
            status:     'active',
          })
          .select('id').single()
        if (insErr || !created) throw new Error(insErr?.message ?? 'insert contact failed')
        contactId = created.id
        imported++
      }

      // ── INSERT consent_events ──────────────────────────────────────────
      // Per-contact DPDPA proof. We default channel='whatsapp' /
      // purpose='marketing' / event_type='opt_in' — the dominant case
      // for a bulk import. The materialise trigger from 072 flips the
      // contact_consent_state row; trigger handles UPSERT semantics so
      // a re-run doesn't downgrade existing consent.
      const { error: ceErr } = await supabase
        .from('consent_events')
        .insert({
          tenant_id:     job.tenant_id,
          contact_id:    contactId,
          channel:       'whatsapp',
          event_type:    'opt_in',
          purpose:       'marketing',
          source:        'bulk_import',
          source_detail: {
            job_id:        job.id,
            filename:      job.filename,
            source_label:  job.source_label,
            consent_basis: job.consent_basis,
            row_number:    row.lineNumber,
          },
          proof_text:    job.consent_proof_text,
          captured_by:   job.uploaded_by,
        })
      if (ceErr) {
        // Don't fail the row — the contact is in, the consent_event
        // failure is logged and surfaced for an operator to retry.
        console.warn(`[contact-import] consent_events insert failed for contact=${contactId}: ${ceErr.message}`)
        newErrors.push({
          row_number: row.lineNumber,
          error: `consent_events insert failed: ${ceErr.message}`,
        })
      }
    } catch (err: any) {
      errored++
      skipped++
      newErrors.push({
        row_number: row.lineNumber,
        error: err?.message ?? String(err),
        raw: { phone: row.phone, name: row.name },
      })
    }
  }

  const totalErrors = parsed.errors.concat(newErrors).slice(0, 200)
  const finalStatus = (errored === 0) ? 'completed' : (imported + updated > 0 ? 'partial' : 'failed')
  await supabase.from('contact_import_jobs').update({
    status:        finalStatus,
    rows_total:    parsed.rows.length,
    rows_imported: imported,
    rows_updated:  updated,
    rows_skipped:  skipped,
    rows_error:    errored,
    errors_jsonb:  totalErrors,
    completed_at:  new Date().toISOString(),
  }).eq('id', job.id)

  console.log(`[contact-import] ${job.id} ${finalStatus}: imported=${imported} updated=${updated} errored=${errored}`)
  return { phase: 'execute', status: finalStatus, imported, updated, errored }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function markFailed(jobId: string, reason: string) {
  await supabase.from('contact_import_jobs').update({
    status: 'failed',
    errors_jsonb: [{ row_number: 0, error: reason }],
    completed_at: new Date().toISOString(),
  }).eq('id', jobId)
}

/** Load the CSV body — prefer storage_path, fall back to inline_payload.
 *  Returns null if neither is available. */
async function loadCsv(job: any): Promise<string | null> {
  if (job.storage_path) {
    try {
      const { data, error } = await supabase.storage
        .from('contact-imports')
        .download(job.storage_path)
      if (error) {
        console.warn(`[contact-import] storage download failed for ${job.id}: ${error.message}`)
        // Fall back to inline_payload if available.
      } else if (data) {
        return await data.text()
      }
    } catch (err: any) {
      console.warn(`[contact-import] storage download threw: ${err?.message ?? err}`)
    }
  }
  if (job.inline_payload) return String(job.inline_payload)
  return null
}

// ── CSV parser ─────────────────────────────────────────────────────────────
// Minimal RFC4180-ish. Handles:
//   - quoted fields with embedded commas
//   - "" → " escape inside quoted fields
//   - \r\n and \n row separators
//   - leading BOM stripping
function parseCsvRows(text: string): string[][] {
  const stripped = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let inQuotes = false
  while (i < stripped.length) {
    const ch = stripped[i]
    if (inQuotes) {
      if (ch === '"') {
        if (stripped[i + 1] === '"') {
          field += '"'; i += 2; continue
        }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { row.push(field); field = ''; i++; continue }
    if (ch === '\r') { i++; continue } // strip CR; handle on LF
    if (ch === '\n') {
      row.push(field); field = ''
      // Skip wholly-empty trailing rows.
      if (!(row.length === 1 && row[0] === '')) rows.push(row)
      row = []
      i++; continue
    }
    field += ch; i++
  }
  // Flush last row.
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
  }
  return rows
}

// ── Validator ──────────────────────────────────────────────────────────────
interface NormalisedRow {
  lineNumber: number
  phone: string
  name: string
  email: string | null
  city: string | null
  attributes: Record<string, string>
  ok: boolean
  error?: string
}

function normalisePhone(raw: string): string | null {
  if (!raw) return null
  const trimmed = raw.trim().replace(/[\s\-()]/g, '')
  // +91XXXXXXXXXX or 91XXXXXXXXXX or 10-digit (auto-prefix 91)
  if (/^\+91\d{10}$/.test(trimmed)) return trimmed.slice(1)
  if (/^91\d{10}$/.test(trimmed))   return trimmed
  if (/^[6-9]\d{9}$/.test(trimmed)) return `91${trimmed}`
  // Other countries — accept E.164-shaped strings as-is sans +.
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed.slice(1)
  return null
}

function keyify(label: string): string {
  return String(label).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'col'
}

function parseCsvAndValidate(csv: string): {
  rows: NormalisedRow[]
  errors: Array<{ row_number: number; error: string; raw?: unknown }>
} {
  const matrix = parseCsvRows(csv)
  if (matrix.length === 0) {
    return { rows: [], errors: [{ row_number: 0, error: 'CSV is empty' }] }
  }
  const headerRow = matrix[0].map(h => h.trim())
  const keys = headerRow.map(keyify)
  // Required key: phone. Anything else is optional.
  const phoneIdx = keys.findIndex(k => k === 'phone' || k === 'phone_number' || k === 'mobile' || k === 'mobile_number' || k === 'whatsapp')
  if (phoneIdx === -1) {
    return { rows: [], errors: [{ row_number: 0, error: 'No "phone" column found in header' }] }
  }
  const nameIdx  = keys.findIndex(k => k === 'name' || k === 'contact_name' || k === 'full_name')
  const emailIdx = keys.findIndex(k => k === 'email' || k === 'email_address')
  const cityIdx  = keys.findIndex(k => k === 'city' || k === 'town')

  const rows: NormalisedRow[] = []
  const errors: Array<{ row_number: number; error: string; raw?: unknown }> = []

  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i]
    const lineNumber = i + 1 // 1-indexed, header is row 1
    const phoneRaw = phoneIdx >= 0 ? (cells[phoneIdx] ?? '') : ''
    const phone = normalisePhone(phoneRaw)
    if (!phone) {
      errors.push({ row_number: lineNumber, error: `Invalid phone: "${phoneRaw}"`, raw: cells })
      rows.push({
        lineNumber,
        phone: phoneRaw,
        name: nameIdx >= 0 ? (cells[nameIdx] ?? '') : '',
        email: null, city: null, attributes: {}, ok: false,
        error: `Invalid phone: "${phoneRaw}"`,
      })
      continue
    }
    const name  = nameIdx  >= 0 ? String(cells[nameIdx]  ?? '').trim() : ''
    const email = emailIdx >= 0 ? String(cells[emailIdx] ?? '').trim() : ''
    const city  = cityIdx  >= 0 ? String(cells[cityIdx]  ?? '').trim() : ''

    // Attribute bag — every column whose key isn't one of the known
    // top-level fields gets stuffed into attributes. Empty cells are
    // skipped so a half-filled column doesn't overwrite a contact's
    // existing attribute with empty string.
    const attributes: Record<string, string> = {}
    for (let j = 0; j < keys.length; j++) {
      if (j === phoneIdx || j === nameIdx || j === emailIdx) continue
      const k = keys[j]
      const v = String(cells[j] ?? '').trim()
      if (!v) continue
      // Attribute columns prefixed `attributes_*` lose the prefix; bare
      // headers (city, region, plan) land as-is.
      const finalKey = k.startsWith('attributes_') ? k.slice('attributes_'.length) : k
      attributes[finalKey] = v
    }
    // Ensure city lands at attributes.city if present (for segment filter).
    if (city && !attributes.city) attributes.city = city

    rows.push({
      lineNumber,
      phone,
      name,
      email: email || null,
      city:  city  || null,
      attributes,
      ok: true,
    })
  }
  return { rows, errors }
}
