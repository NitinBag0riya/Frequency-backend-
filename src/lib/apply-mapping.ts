/**
 * apply-mapping.ts — shared transform pipeline applied at every server-side
 * ingest entry point that has a pinned `default_mapping_id`.
 *
 * Today's callers:
 *   • POST /api/ingest/:token        (webhook)        — leads.ts
 *   • data-source-sync (Google Sheets)               — workers/data-source-sync.ts
 *   • data-source-sync (Airtable)                    — workers/data-source-sync.ts
 *
 * The frontend has a mirror of this logic in
 *   src/components/leads/MappingDetailsCallout.tsx
 * for the live before/after preview. Keep the two in sync — same transform
 * kinds, same semantics.
 *
 * Why a shared module:
 *   - Three ingest paths each used to inline their own column-rename logic
 *     (csv import had its own, webhook handler dropped raw, sync did keyify).
 *     Mappings now live in one library, and the act of applying them must
 *     live in one place too — otherwise transforms drift between paths and
 *     the user can't predict what they get.
 *
 * Mapping persistence shape (legacy + current both supported):
 *   - Plain string:                 stored as 'target_column_key'
 *   - With transforms:              JSON-encoded {"target":"col","transforms":[...]}
 *   - Decoder tolerates both.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type TransformOp =
  | { kind: 'lowercase' }
  | { kind: 'uppercase' }
  | { kind: 'trim' }
  | { kind: 'regex_extract'; pattern: string; group?: number }
  | { kind: 'replace'; from: string; to: string }
  | { kind: 'coerce'; to: 'number' | 'date_iso' | 'boolean' | 'csv' }
  | { kind: 'default'; value: string }

export interface DecodedField {
  source: string
  target: string
  transforms?: TransformOp[]
}

/** Decode a `lead_field_mappings.mappings` jsonb cell into rule objects.
 *  Legacy entries store the target as a bare string; current entries store
 *  a JSON-encoded object `{ target, transforms }`. Both decode correctly. */
export function decodeMapping(raw: Record<string, unknown> | null | undefined): DecodedField[] {
  if (!raw) return []
  const out: DecodedField[] = []
  for (const [source, val] of Object.entries(raw)) {
    let target = String(val)
    let transforms: TransformOp[] | undefined
    try {
      const parsed = JSON.parse(String(val))
      if (parsed && typeof parsed === 'object' && 'target' in parsed) {
        target = String(parsed.target)
        if (Array.isArray(parsed.transforms)) transforms = parsed.transforms as TransformOp[]
      }
    } catch { /* plain string target — already assigned above */ }
    out.push({ source, target, transforms })
  }
  return out
}

/** Resolve a dotted source path against an inbound payload object.
 *  Mirrors the FE preview helper so the user's preview matches reality. */
export function pickPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined
  return path.split('.').reduce<any>((acc, key) => acc == null ? undefined : acc[key], obj)
}

/** Apply a transform pipeline left-to-right.
 *  Failure modes are intentionally lenient: a bad regex pattern keeps the
 *  value unchanged rather than rejecting the whole row, since rows arrive
 *  in batches and one malformed cell shouldn't poison the rest. */
export function applyTransforms(value: unknown, ops: TransformOp[] | undefined): unknown {
  if (!ops || ops.length === 0) return value
  let v: any = value
  for (const op of ops) {
    switch (op.kind) {
      case 'trim':       v = (v == null ? '' : String(v)).trim(); break
      case 'lowercase':  v = (v == null ? '' : String(v)).toLowerCase(); break
      case 'uppercase':  v = (v == null ? '' : String(v)).toUpperCase(); break
      case 'replace':    v = (v == null ? '' : String(v)).split(op.from).join(op.to); break
      case 'regex_extract': {
        try {
          const m = String(v ?? '').match(new RegExp(op.pattern))
          v = m ? m[op.group ?? 0] : ''
        } catch { /* invalid regex — keep value unchanged */ }
        break
      }
      case 'coerce': {
        const s = String(v ?? '').trim()
        if (op.to === 'number')   v = s === '' ? null : Number(s.replace(/[^\d.\-]/g, ''))
        if (op.to === 'date_iso') {
          const d = new Date(s)
          v = isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
        }
        if (op.to === 'boolean')  v = ['true', 'yes', '1', 'y', 'on'].includes(s.toLowerCase())
        if (op.to === 'csv')      v = s ? s.split(',').map(x => x.trim()).filter(Boolean) : []
        break
      }
      case 'default':    if (v == null || v === '') v = op.value; break
    }
  }
  return v
}

/** Apply the decoded mapping to a single inbound payload, producing a flat
 *  `Record<string, string>` ready for `lead_rows.data` (jsonb).
 *
 *  - Skips fields whose target is empty / '__skip__'
 *  - Coerces non-string transformed values (e.g. coerce→number) into strings
 *    so the JSONB shape stays predictable — same convention the webhook
 *    handler used before this refactor.
 *  - Preserves the `airtable_record_id` passthrough key when present in the
 *    raw payload (caller can merge it back in after mapping if needed).
 */
export function applyMappingToPayload(
  rules: DecodedField[],
  payload: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rule of rules) {
    if (!rule.target || rule.target === '__skip__') continue
    const raw = pickPath(payload, rule.source)
    const transformed = applyTransforms(raw, rule.transforms)
    if (transformed === undefined || transformed === null) continue
    out[rule.target] = typeof transformed === 'object'
      ? JSON.stringify(transformed)
      : String(transformed)
  }
  return out
}

/** Load + decode a saved mapping by id, tenant-scoped. Returns null when the
 *  mapping doesn't exist or doesn't belong to the tenant — callers should
 *  fall back to verbatim behaviour rather than failing the ingest. */
export async function loadMapping(
  supabase: SupabaseClient,
  tenantId: string,
  mappingId: string | null | undefined,
): Promise<DecodedField[] | null> {
  if (!mappingId) return null
  const { data, error } = await supabase
    .from('lead_field_mappings')
    .select('mappings')
    .eq('id', mappingId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (error || !data) return null
  return decodeMapping((data as any).mappings)
}
