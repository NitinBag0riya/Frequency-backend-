import { Router } from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Request, Response, NextFunction } from 'express'

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void

// ── Helpers ───────────────────────────────────────────────────────────────────

function toKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field'
}

function matchesConditions(data: Record<string, unknown>, conditions: Condition[]): boolean {
  if (!conditions || conditions.length === 0) return true
  return conditions.every(c => {
    const val = String(data[c.field] ?? '').toLowerCase()
    const cval = String(c.value ?? '').toLowerCase()
    switch (c.operator) {
      case 'equals':       return val === cval
      case 'not_equals':   return val !== cval
      case 'contains':     return val.includes(cval)
      case 'not_contains': return !val.includes(cval)
      case 'starts_with':  return val.startsWith(cval)
      case 'greater_than': return Number(val) > Number(cval)
      case 'less_than':    return Number(val) < Number(cval)
      case 'is_empty':     return !val
      case 'is_not_empty': return !!val
      default:             return false
    }
  })
}

interface Condition {
  field: string
  operator: string
  value: string
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createLeadsRouter(supabase: SupabaseClient, requireAuth: AuthMiddleware, identifyTenant: AuthMiddleware, checkPermission: any) {
  const router = Router()

  // ── Tables ─────────────────────────────────────────────────────────────

  router.get('/lead-tables', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_tables')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.post('/lead-tables', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, description = '', source = 'manual', columns = [] } = req.body
    if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return }

    const userId = (req as any).user.id
    const { data: table, error } = await supabase
      .from('lead_tables')
      .insert({ name: name.trim(), description, source, tenant_id: tenantId, user_id: userId })
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }

    // Insert columns
    const defaultCols = columns.length > 0 ? columns : [
      { name: 'Name',   key: 'name',   type: 'text',  is_primary: true,  is_required: true  },
      { name: 'Phone',  key: 'phone',  type: 'phone', is_primary: false, is_required: false },
      { name: 'Email',  key: 'email',  type: 'email', is_primary: false, is_required: false },
      { name: 'Status', key: 'status', type: 'select',is_primary: false, is_required: false,
        options: ['new', 'contacted', 'qualified', 'lost', 'won'] },
      { name: 'Source', key: 'source', type: 'text',  is_primary: false, is_required: false },
      { name: 'Notes',  key: 'notes',  type: 'textarea', is_primary: false, is_required: false },
    ]

    const colRows = defaultCols.map((c: any, i: number) => ({
      table_id:    table.id,
      tenant_id:   tenantId,
      user_id:     userId,
      name:        c.name,
      key:         c.key || toKey(c.name),
      type:        c.type || 'text',
      options:     c.options || [],
      is_required: c.is_required || false,
      is_primary:  c.is_primary || i === 0,
      position:    i,
    }))
    await supabase.from('lead_columns').insert(colRows)

    res.json(table)
  })

  router.get('/lead-tables/:id', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: table, error } = await supabase
      .from('lead_tables')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .single()
    if (error) { res.status(404).json({ error: 'Table not found' }); return }

    const { data: columns } = await supabase
      .from('lead_columns')
      .select('*')
      .eq('table_id', table.id)
      .eq('tenant_id', tenantId)
      .order('position')

    res.json({ ...table, columns: columns ?? [] })
  })

  router.patch('/lead-tables/:id', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_tables')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.delete('/lead-tables/:id', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('lead_tables')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // ── Columns ─────────────────────────────────────────────────────────────────

  router.post('/lead-tables/:id/columns', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, type = 'text', options = [], is_required = false } = req.body
    if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return }

    const { data: existing } = await supabase
      .from('lead_columns')
      .select('position')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .order('position', { ascending: false })
      .limit(1)
    const position = ((existing?.[0] as any)?.position ?? -1) + 1

    let userId = (req as any).user?.id
    
    if (!userId) {
      // Fallback: get the user_id from the tenant record
      const { data: t } = await supabase.from('tenants').select('user_id').eq('id', tenantId).single()
      userId = t?.user_id
    }

    console.log(`[addColumn] table=${req.params.id}, tenant=${tenantId}, user=${userId || '(MISSING)'}`)

    if (!userId) {
      console.error('[addColumn] ERROR: No user ID found in request or tenant')
      res.status(401).json({ error: 'User ID missing' }); return
    }

    if (!tenantId) {
      console.error('[addColumn] ERROR: No tenant ID found in request')
      res.status(400).json({ error: 'Tenant ID missing' }); return
    }

    try {
      const { data, error } = await supabase
        .from('lead_columns')
        .insert({
          table_id: req.params.id, 
          tenant_id: tenantId, 
          user_id: userId,
          name: name.trim(), 
          key: toKey(name), 
          type, 
          options, 
          is_required, 
          position,
        })
        .select()
        .single()

      if (error) {
        console.error('[addColumn] DB ERROR:', JSON.stringify(error, null, 2))
        res.status(500).json({ error: error.message }); return
      }
      res.json(data)
    } catch (err: any) {
      console.error('[addColumn] FATAL ERROR:', err.message)
      res.status(500).json({ error: err.message }); return
    }
  })

  router.patch('/lead-tables/:id/columns/:colId', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_columns')
      .update(req.body)
      .eq('id', req.params.colId)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.delete('/lead-tables/:id/columns/:colId', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('lead_columns')
      .delete()
      .eq('id', req.params.colId)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // ── Rows ────────────────────────────────────────────────────────────────────

  router.get('/lead-tables/:id/rows', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const {
      search, status, assigned_to, tag,
      limit = '100', offset = '0',
    } = req.query as Record<string, string>

    let q = supabase
      .from('lead_rows')
      .select('*', { count: 'exact' })
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (status)      q = q.eq('status', status)
    if (assigned_to) q = q.eq('assigned_to', assigned_to)
    if (tag)         q = q.contains('tags', [tag])
    if (search)      q = (q as any).ilike('data::text', `%${search}%`)

    // Dynamic data filters
    const filters = req.query.filters as string
    if (filters) {
      try {
        const parsed = JSON.parse(filters)
        Object.entries(parsed).forEach(([key, val]) => {
          if (val) {
            q = q.ilike(`data->>${key}`, `%${val}%`)
          }
        })
      } catch (e) {}
    }

    const { data, count, error } = await q
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ rows: data ?? [], total: count ?? 0 })
  })

  router.post('/lead-tables/:id/rows', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_rows')
      .insert({
        table_id:         req.params.id,
        tenant_id:        tenantId,
        user_id:          (req as any).user.id,
        data:             req.body.data ?? {},
        assigned_to:      req.body.assigned_to ?? null,
        assigned_to_name: req.body.assigned_to_name ?? '',
        tags:             req.body.tags ?? [],
        status:           req.body.status ?? 'new',
      })
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.patch('/lead-tables/:id/rows/:rowId', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_rows')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', req.params.rowId)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.delete('/lead-tables/:id/rows/:rowId', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('lead_rows')
      .delete()
      .eq('id', req.params.rowId)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  router.delete('/lead-tables/:id/rows', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { ids } = req.body as { ids: string[] }
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array required' }); return
    }
    const { error } = await supabase
      .from('lead_rows')
      .delete()
      .in('id', ids)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ deleted: ids.length })
  })

  // ── Bulk Import ──────────────────────────────────────────────────────────────

  router.post('/lead-tables/:id/import', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { rows, mappings } = req.body as {
      rows: Record<string, string>[]
      mappings: Record<string, string>
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'rows array is required' }); return
    }

    const transformed = rows.map(row => {
      const data: Record<string, string> = {}
      if (mappings && Object.keys(mappings).length > 0) {
        Object.entries(mappings).forEach(([src, target]) => {
          if (target && target !== '__skip__' && row[src] !== undefined) {
            data[target] = String(row[src] ?? '').trim()
          }
        })
      } else {
        Object.entries(row).forEach(([k, v]) => { data[toKey(k)] = String(v ?? '').trim() })
      }
      return { table_id: req.params.id, tenant_id: tenantId, user_id: (req as any).user.id, data, status: 'new', tags: [] }
    })

    let inserted = 0
    const BATCH = 500
    for (let i = 0; i < transformed.length; i += BATCH) {
      const { error } = await supabase.from('lead_rows').insert(transformed.slice(i, i + BATCH))
      if (error) { res.status(500).json({ error: error.message, inserted }); return }
      inserted += Math.min(BATCH, transformed.length - i)
    }

    res.json({ inserted })
  })

  // ── Assignment Rules ─────────────────────────────────────────────────────────

  router.get('/lead-tables/:id/assignments', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_assignment_rules')
      .select('*')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .order('priority')
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.post('/lead-tables/:id/assignments', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_assignment_rules')
      .insert({ ...req.body, table_id: req.params.id, tenant_id: tenantId, user_id: (req as any).user.id })
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.patch('/lead-tables/:id/assignments/:ruleId', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_assignment_rules')
      .update(req.body)
      .eq('id', req.params.ruleId)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.delete('/lead-tables/:id/assignments/:ruleId', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('lead_assignment_rules')
      .delete()
      .eq('id', req.params.ruleId)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // Apply assignment rules to rows in a table (or a filtered segment)
  router.post('/lead-tables/:id/apply-assignments', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { row_ids, filter } = req.body as {
      row_ids?: string[]
      filter?: { status?: string; assigned_to?: string }
    }

    const { data: rules } = await supabase
      .from('lead_assignment_rules')
      .select('*')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('priority')

    if (!rules?.length) { res.json({ updated: 0 }); return }

    let q = supabase
      .from('lead_rows')
      .select('*')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)

    if (row_ids?.length) q = q.in('id', row_ids)
    if (filter?.status)      q = q.eq('status', filter.status)
    if (filter?.assigned_to) q = q.eq('assigned_to', filter.assigned_to)

    const { data: rows } = await q
    if (!rows?.length) { res.json({ updated: 0 }); return }

    let updated = 0
    for (const row of rows as any[]) {
      for (const rule of rules as any[]) {
        if (matchesConditions(row.data ?? {}, rule.conditions ?? [])) {
          const newTags = [...new Set([...(row.tags ?? []), ...(rule.apply_tags ?? [])])]
          await supabase.from('lead_rows').update({
            assigned_to:      rule.assign_to,
            assigned_to_name: rule.assign_to_name,
            tags:             newTags,
            updated_at:       new Date().toISOString(),
          }).eq('id', row.id).eq('tenant_id', tenantId)
          updated++
          break // first matching rule wins (priority order)
        }
      }
    }
    res.json({ updated })
  })

  // ── Field Mapping Presets ────────────────────────────────────────────────────
  
  router.get('/lead-mappings', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_field_mappings')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.get('/lead-tables/:id/mappings', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_field_mappings')
      .select('*')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.post('/lead-tables/:id/mappings', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_field_mappings')
      .insert({ ...req.body, table_id: req.params.id, tenant_id: tenantId, user_id: (req as any).user.id })
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.delete('/lead-tables/:id/mappings/:mapId', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('lead_field_mappings')
      .delete()
      .eq('id', req.params.mapId)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  router.get('/lead-tables/:id/lookup-options/:colKey', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const { id, colKey } = req.params
    const tenantId = (req as any).tenantId

    const { data, error } = await supabase
      .from('lead_rows')
      .select('data')
      .eq('table_id', id)
      .eq('tenant_id', tenantId)

    if (error) { res.status(500).json({ error: error.message }); return }

    const options = [...new Set(data.map(r => r.data?.[String(colKey)]).filter(Boolean))].sort()
    res.json(options)
  })

  return router
}
