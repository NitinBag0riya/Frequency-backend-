/**
 * Real-estate vertical — property listings CRUD. Per-tenant, RLS-backed
 * (listings_tenant_members). Same shape as the Khata router. Gated in the FE to
 * business_type = real_estate. Leads/bookings are follow-on modules.
 */
import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

const KINDS = ['sale', 'rent'] as const
const STATUSES = ['available', 'under_offer', 'sold', 'rented'] as const

export function createListingsRouter(supabase: SupabaseClient, requireAuth: Mw, identifyTenant: Mw, checkPermission: (f: string, a: 'view' | 'edit' | 'delete') => Mw) {
  const router = express.Router()
  const view = [requireAuth, identifyTenant, checkPermission('leads', 'view')]
  const edit = [requireAuth, identifyTenant, checkPermission('leads', 'edit')]

  // GET /listings — all listings for the tenant (optional ?status= / ?q= filters).
  router.get('/listings', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    let q = supabase.from('listings').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    if (req.query.status) q = q.eq('status', String(req.query.status))
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    let listings = data ?? []
    const term = String(req.query.q ?? '').trim().toLowerCase()
    if (term) listings = listings.filter(l => `${l.title} ${l.locality ?? ''} ${l.city ?? ''}`.toLowerCase().includes(term))
    res.json({ listings })
  })

  // GET /listings/summary — counts for the header.
  router.get('/listings/summary', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('listings').select('status,price,kind').eq('tenant_id', tenantId)
    if (error) return res.status(500).json({ error: error.message })
    const rows = data ?? []
    const by = (s: string) => rows.filter(r => r.status === s).length
    res.json({
      total: rows.length,
      available: by('available'),
      underOffer: by('under_offer'),
      closed: by('sold') + by('rented'),
    })
  })

  // POST /listings — create.
  router.post('/listings', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title is required' })
    const kind = KINDS.includes(b.kind) ? b.kind : 'sale'
    const status = STATUSES.includes(b.status) ? b.status : 'available'
    const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v))
    const { data, error } = await supabase.from('listings').insert({
      tenant_id: tenantId,
      title: String(b.title).trim(),
      kind, status,
      property_type: b.propertyType ?? null,
      price: num(b.price), bedrooms: num(b.bedrooms), bathrooms: num(b.bathrooms), area_sqft: num(b.areaSqft),
      locality: b.locality ?? null, city: b.city ?? null,
      description: b.description ?? null, cover_image: b.coverImage ?? null,
      by_email: (req as any).user?.email ?? null,
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ listing: data })
  })

  // PATCH /listings/:id — update any field.
  router.patch('/listings/:id', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    const num = (v: any) => (v === '' ? null : Number(v))
    if (b.title !== undefined) patch.title = String(b.title).trim()
    if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'bad kind' }); patch.kind = b.kind }
    if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad status' }); patch.status = b.status }
    if (b.propertyType !== undefined) patch.property_type = b.propertyType
    for (const [k, col] of [['price', 'price'], ['bedrooms', 'bedrooms'], ['bathrooms', 'bathrooms'], ['areaSqft', 'area_sqft']] as const)
      if (b[k] !== undefined) patch[col] = num(b[k])
    if (b.locality !== undefined) patch.locality = b.locality
    if (b.city !== undefined) patch.city = b.city
    if (b.description !== undefined) patch.description = b.description
    if (b.coverImage !== undefined) patch.cover_image = b.coverImage
    const { data, error } = await supabase.from('listings').update(patch).eq('tenant_id', tenantId).eq('id', req.params.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ listing: data })
  })

  // DELETE /listings/:id
  router.delete('/listings/:id', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase.from('listings').delete().eq('tenant_id', tenantId).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  return router
}
