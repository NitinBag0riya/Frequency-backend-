#!/usr/bin/env node
/**
 * flush-and-seed.mjs
 *
 * Flushes ALL data tables (keeps schemas + system seeds: plans, role_definitions,
 * notification_event_types, feature_flags, approval_rules) and then provisions
 * exactly 2 demo accounts:
 *
 *   1. Super Admin       — platform_owner role at platform scope
 *   2. Tenant Owner      — owner role for "Acme Realty Pvt Ltd"
 *      + 4 sample team members spanning all 11 tenant roles
 *      + connected apps stub rows (WhatsApp, Instagram, Telegram, Razorpay,
 *        Shopify, Google Sheets, Meta Ads)
 *      + sample contacts, broadcasts, campaigns, messages, notifications,
 *        catalog products, flows, QR codes, IG posts, ad campaigns, audiences,
 *        announcements
 *
 * Prints a credentials table at the end.
 *
 * Usage:  node scripts/flush-and-seed.mjs
 */

import 'dotenv/config'

const SUPABASE_URL = process.env.SUPABASE_URL
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
const PROJECT_REF = (SUPABASE_URL || '').match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]
const PAT = process.env.SUPABASE_ACCESS_TOKEN

if (!SUPABASE_URL || !SVC) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
if (!PAT || !PROJECT_REF)  { console.error('Missing SUPABASE_ACCESS_TOKEN (needed for raw SQL flush)'); process.exit(1) }

// ── Helpers ──────────────────────────────────────────────────────────────
async function rest(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SVC, Authorization: `Bearer ${SVC}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers ?? {}),
    },
  })
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${await r.text()}`)
  return r.status === 204 ? null : r.json()
}

async function authAdmin(method, path, body) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    method,
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok && r.status !== 422) throw new Error(`auth ${method} ${path} → ${r.status}: ${await r.text()}`)
  return r.json().catch(() => ({}))
}

async function execSql(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAT}`,
      'Content-Type': 'application/json',
      'User-Agent': 'frequency-seed/1.0',
    },
    body: JSON.stringify({ query: sql }),
  })
  if (!r.ok) throw new Error(`SQL → ${r.status}: ${await r.text()}`)
  return r.json()
}

async function upsertUser(email, password, fullName) {
  // Find or create
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
  }).then(r => r.json())
  const existing = (list.users ?? []).find(u => u.email === email)
  if (existing) {
    await authAdmin('PUT', `/users/${existing.id}`, { password, email_confirm: true, user_metadata: { full_name: fullName } })
    return existing.id
  }
  const created = await authAdmin('POST', '/users', { email, password, email_confirm: true, user_metadata: { full_name: fullName } })
  return created.id
}

const log = (...m) => console.log('•', ...m)
const ok  = (...m) => console.log('✓', ...m)

// ── 1. Flush all data tables (keep system seeds) ────────────────────────
async function flush() {
  log('Flushing data tables (keeping plans/roles/event_types/feature_flags/approval_rules)…')
  // Use DELETE FROM (not TRUNCATE CASCADE) to avoid accidentally clearing
  // role_definitions/plans/feature_flags via FK cascades. Order matters: clear
  // children before parents.
  const tables = [
    'notification_delivery_log','notifications','notification_preferences',
    'super_admin_audit','platform_announcements',
    'approval_requests','pending_invites',
    'role_label_overrides','user_role_assignments','departments',
    'tenant_entitlements','tenant_subscriptions','tenant_usage',
    'workflow_recommendations',
    'meta_audiences','meta_lead_forms','meta_ad_campaigns','meta_ad_accounts',
    'tg_invoices','tg_mini_apps','tg_bots',
    'ig_posts','ig_comment_rules',
    'wa_business_profiles','wa_qr_codes','wa_flow_responses','wa_flows','wa_catalog_products',
    'workflow_executions','scheduled_jobs','workflow_sessions',
    'messages','broadcasts','campaign_enrollments','campaign_steps','campaigns',
    'contacts','workflows','wa_templates','tenant_integrations',
    'tenants','user_roles',
  ]
  await execSql(tables.map(t => `DELETE FROM public.${t};`).join('\n'))

  // Defensive: ensure system seeds are still there (re-apply 018 if anything got wiped)
  log('Verifying system seeds (plans/roles/event_types) intact…')
  const check = await execSql(`SELECT
    (SELECT count(*) FROM role_definitions) AS roles,
    (SELECT count(*) FROM plans)            AS plans,
    (SELECT count(*) FROM notification_event_types) AS evts,
    (SELECT count(*) FROM feature_flags)    AS flags,
    (SELECT count(*) FROM approval_rules WHERE tenant_id IS NULL) AS rules`)
  const c = check[0]
  if (c.roles < 17 || c.plans < 4) {
    console.warn('  → System seeds missing, please run migrations 018 + 019 then retry seed.')
    throw new Error(`System seeds missing (roles=${c.roles}, plans=${c.plans})`)
  }
  ok(`System seeds intact: ${c.roles} roles · ${c.plans} plans · ${c.evts} event types · ${c.flags} flags · ${c.rules} approval rules`)

  // Delete every auth user (auth.users isn't in public schema; use admin API)
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
  }).then(r => r.json())
  for (const u of list.users ?? []) {
    if (u.email && !u.email.endsWith('@anthropic.com')) {  // sanity guard
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
        method: 'DELETE', headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
      })
    }
  }
  ok('Flush complete')
}

// ── 2. Seed super admin ─────────────────────────────────────────────────
async function seedSuperAdmin() {
  log('Seeding super admin…')
  const id = await upsertUser('owner@frequency.in', 'Owner@2026', 'Platform Owner')
  // Resolve platform_owner role
  const [role] = await rest(`/role_definitions?scope=eq.platform&key=eq.platform_owner&select=id`)
  await rest('/user_role_assignments', {
    method: 'POST',
    body: JSON.stringify({ user_id: id, tenant_id: null, role_id: role.id, accepted_at: new Date().toISOString() }),
  })
  ok(`Super admin user_id=${id}`)
  return id
}

// ── 3. Seed tenant + team + everything ─────────────────────────────────
async function seedTenant(superAdminId) {
  log('Seeding tenant: Acme Realty Pvt Ltd…')

  // 3.1 Owner user
  const ownerId = await upsertUser('priya@acme.in', 'Owner@2026', 'Priya Patel')
  const teamUsers = [
    { email: 'rohan@acme.in',  password: 'Member@2026', name: 'Rohan Sharma',  role: 'workspace_admin'   },
    { email: 'ananya@acme.in', password: 'Member@2026', name: 'Ananya Kapoor', role: 'sales_manager'     },
    { email: 'arjun@acme.in',  password: 'Member@2026', name: 'Arjun Singh',   role: 'sales_rep'         },
    { email: 'meera@acme.in',  password: 'Member@2026', name: 'Meera Nair',    role: 'marketing_manager' },
    { email: 'kunal@acme.in',  password: 'Member@2026', name: 'Kunal Verma',   role: 'support_agent'     },
    { email: 'sneha@acme.in',  password: 'Member@2026', name: 'Sneha Gupta',   role: 'analyst'           },
  ]
  for (const u of teamUsers) {
    u.id = await upsertUser(u.email, u.password, u.name)
  }

  // 3.2 Tenant
  const [tenant] = await rest('/tenants', {
    method: 'POST',
    body: JSON.stringify({
      user_id: ownerId,
      business_name: 'Acme Realty Pvt Ltd',
      display_phone: '+91 98765 43210',
      waba_id: '111222333444555',
      phone_number_id: '999888777666',
      access_token: 'demo_meta_token',
      status: 'active',
    }),
  })
  ok(`Tenant ${tenant.id}`)

  // 3.3 Subscription on Growth (active, not trial)
  await rest('/tenant_subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      tenant_id: tenant.id, plan_id: 'growth', status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
    }),
  })

  // 3.4 Role assignments
  const roles = await rest('/role_definitions?scope=eq.tenant&select=id,key')
  const roleByKey = Object.fromEntries(roles.map(r => [r.key, r.id]))
  await rest('/user_role_assignments', {
    method: 'POST',
    body: JSON.stringify([
      { user_id: ownerId, tenant_id: tenant.id, role_id: roleByKey.owner, accepted_at: new Date().toISOString() },
      ...teamUsers.map(u => ({ user_id: u.id, tenant_id: tenant.id, role_id: roleByKey[u.role], accepted_at: new Date().toISOString() })),
    ]),
  })

  // 3.5 Departments
  const depts = await rest('/departments', {
    method: 'POST',
    body: JSON.stringify([
      { tenant_id: tenant.id, name: 'Sales',     color: '#10b981' },
      { tenant_id: tenant.id, name: 'Marketing', color: '#8b5cf6' },
      { tenant_id: tenant.id, name: 'Support',   color: '#f59e0b' },
    ]),
  })

  // 3.6 Connected apps (tenant_integrations stub rows)
  const integrations = ['instagram','meta_ads','razorpay','shopify','google_sheets','google_drive','google_calendar']
  await rest('/tenant_integrations', {
    method: 'POST',
    body: JSON.stringify(integrations.map(key => ({
      tenant_id: tenant.id, user_id: ownerId, key, status: 'active',
      brand_label: key === 'razorpay' ? 'rzp_test_demo' : key === 'shopify' ? 'acme.myshopify.com' : `Demo ${key}`,
      connected_at: new Date().toISOString(),
    }))),
  })

  // 3.7 Telegram bot
  await rest('/tg_bots', {
    method: 'POST',
    body: JSON.stringify({
      tenant_id: tenant.id, bot_username: 'AcmeRealtyBot', bot_id: 7000000001,
      bot_token: 'iv:demoencrypted', short_description: 'Acme Realty bot',
      description: 'Find your next home with Acme Realty', commands: [
        { command: 'start', description: 'Get started' },
        { command: 'browse', description: 'Browse listings' },
      ],
    }),
  })

  // 3.8 WA templates
  await rest('/wa_templates', {
    method: 'POST',
    body: JSON.stringify([
      { user_id: ownerId, tenant_id: tenant.id, name: 'welcome',          category: 'utility',       language: 'en', status: 'approved', body: 'Hi {{1}}, welcome to Acme Realty! Reply with your area to see listings.', variables: ['1'] },
      { user_id: ownerId, tenant_id: tenant.id, name: 'site_visit_confirm', category: 'utility',     language: 'en', status: 'approved', body: 'Hi {{1}}, your site visit at {{2}} on {{3}} is confirmed!',                  variables: ['1','2','3'] },
      { user_id: ownerId, tenant_id: tenant.id, name: 'diwali_offer',     category: 'marketing',     language: 'en', status: 'approved', body: 'Hi {{1}}! Diwali offer — book a 2BHK and get free interiors worth ₹{{2}}.', variables: ['1','2'] },
    ]),
  })

  // 3.9 Contacts
  // PostgREST bulk insert requires identical keys per row → normalize all
  // contacts to have the same shape (instagram_id/telegram_id default to null).
  const contactsList = [
    { name: 'Rahul Mehta',      phone: '919876500001', tags: ['lead','premium'],  channel_primary: 'whatsapp',  instagram_id: null,            telegram_id: null },
    { name: 'Priya Iyer',       phone: '919876500002', tags: ['customer','vip'],  channel_primary: 'whatsapp',  instagram_id: null,            telegram_id: null },
    { name: 'Amit Joshi',       phone: '919876500003', tags: ['lead'],            channel_primary: 'whatsapp',  instagram_id: null,            telegram_id: null },
    { name: 'Sneha Reddy',      phone: '919876500004', tags: ['customer'],        channel_primary: 'whatsapp',  instagram_id: 'sneha.reddy',   telegram_id: null },
    { name: 'Vikram Joshi',     phone: '919876500005', tags: ['lead','warm'],     channel_primary: 'whatsapp',  instagram_id: null,            telegram_id: null },
    { name: 'Anjali Kumar',     phone: '919876500006', tags: ['customer','vip'],  channel_primary: 'whatsapp',  instagram_id: null,            telegram_id: null },
    { name: 'Rohit Singh',      phone: '919876500007', tags: ['lead','hot'],      channel_primary: 'instagram', instagram_id: 'rohit.singh.99', telegram_id: null },
    { name: 'Pooja Verma',      phone: '919876500008', tags: ['customer'],        channel_primary: 'telegram',  instagram_id: null,            telegram_id: '5000000001' },
    { name: 'Karan Mehta',      phone: '919876500009', tags: ['lead'],            channel_primary: 'whatsapp',  instagram_id: null,            telegram_id: null },
    { name: 'Divya Sharma',     phone: '919876500010', tags: ['customer','vip'],  channel_primary: 'whatsapp',  instagram_id: null,            telegram_id: null },
  ].map(c => ({ ...c, user_id: ownerId, tenant_id: tenant.id, status: 'active' }))
  const contacts = await rest('/contacts', { method: 'POST', body: JSON.stringify(contactsList) })

  // 3.10 Messages — recent inbound + outbound spread across channels
  const now = Date.now()
  const messages = []
  contacts.slice(0, 8).forEach((c, idx) => {
    const channel = c.channel_primary
    const phoneId = c.telegram_id ?? c.instagram_id ?? c.phone
    messages.push(
      { tenant_id: tenant.id, channel, direction: 'inbound',  contact_phone: phoneId, content: { type: 'text', text: 'Hi, I saw your listing. Interested!' }, status: 'sent', created_at: new Date(now - (idx + 1) * 600000).toISOString() },
      { tenant_id: tenant.id, channel, direction: 'outbound', contact_phone: phoneId, content: { type: 'text', text: `Hi ${c.name.split(' ')[0]}! Which area are you looking in?` }, status: 'delivered', created_at: new Date(now - (idx + 1) * 600000 + 60000).toISOString() },
      { tenant_id: tenant.id, channel, direction: 'inbound',  contact_phone: phoneId, content: { type: 'text', text: 'Whitefield or Indiranagar.' }, status: 'sent', created_at: new Date(now - (idx + 1) * 600000 + 120000).toISOString() },
    )
  })
  await rest('/messages', { method: 'POST', body: JSON.stringify(messages) })

  // 3.11 Broadcasts (normalize to identical keys for PostgREST bulk insert)
  await rest('/broadcasts', {
    method: 'POST',
    body: JSON.stringify([
      { user_id: ownerId, tenant_id: tenant.id, channel: 'whatsapp', name: 'Diwali Offer',          template_name: 'diwali_offer',       language: 'en',status: 'sent',      sent_at: new Date(now - 86400000 * 2).toISOString(), scheduled_at: null,                                         stats: { sent: 480, delivered: 472, read: 410, replied: 84, failed: 8 } },
      { user_id: ownerId, tenant_id: tenant.id, channel: 'whatsapp', name: 'Site visit reminders', template_name: 'site_visit_confirm', language: 'en',status: 'scheduled', sent_at: null,                                       scheduled_at: new Date(now + 86400000).toISOString(), stats: { sent: 0,   delivered: 0,   read: 0,   replied: 0,  failed: 0 } },
      { user_id: ownerId, tenant_id: tenant.id, channel: 'whatsapp', name: 'Welcome blast',        template_name: 'welcome',            language: 'en',status: 'draft',     sent_at: null,                                       scheduled_at: null,                                         stats: { sent: 0,   delivered: 0,   read: 0,   replied: 0,  failed: 0 } },
    ]),
  })

  // 3.12 Campaigns
  const [camp] = await rest('/campaigns', {
    method: 'POST',
    body: JSON.stringify([{
      user_id: ownerId, tenant_id: tenant.id,
      name: 'Lead Nurture Drip', description: '5-touch drip for new website leads',
      type: 'drip', status: 'active',
      stats: { enrolled: 248, active: 112, converted: 34, revenue: 68000 },
    }]),
  })
  await rest('/campaign_steps', {
    method: 'POST',
    body: JSON.stringify([
      { campaign_id: camp.id, tenant_id: tenant.id, position: 0, kind: 'send_template', channel: 'whatsapp', config: { template_name: 'welcome' } },
      { campaign_id: camp.id, tenant_id: tenant.id, position: 1, kind: 'wait_delay',    channel: null,       config: { delay_minutes: 1440 } },
      { campaign_id: camp.id, tenant_id: tenant.id, position: 2, kind: 'send_template', channel: 'whatsapp', config: { template_name: 'site_visit_confirm' } },
      { campaign_id: camp.id, tenant_id: tenant.id, position: 3, kind: 'end',           channel: null,       config: {} },
    ]),
  })

  // 3.13 WA catalog products
  await rest('/wa_catalog_products', {
    method: 'POST',
    body: JSON.stringify([
      { tenant_id: tenant.id, retailer_id: 'sku-2bhk-sky',  name: '2 BHK · Sky Tower',         description: '1180 sqft · East-facing · Whitefield',  price: 8500000,  currency: 'INR', source: 'manual', image_url: 'https://placehold.co/400x400/10b981/white?text=2BHK' },
      { tenant_id: tenant.id, retailer_id: 'sku-3bhk-grdn', name: '3 BHK · Garden Estates',    description: '1640 sqft · 2 balconies · Indiranagar', price: 14500000, currency: 'INR', source: 'manual', image_url: 'https://placehold.co/400x400/3b82f6/white?text=3BHK' },
      { tenant_id: tenant.id, retailer_id: 'sku-plot-dev',  name: 'Premium Plot · Devanahalli', description: '2400 sqft · BBMP-approved',            price: 6200000,  currency: 'INR', source: 'manual', image_url: 'https://placehold.co/400x400/8b5cf6/white?text=Plot' },
    ]),
  })

  // 3.14 WA flows + QR + business profile
  await rest('/wa_flows', {
    method: 'POST',
    body: JSON.stringify([
      { tenant_id: tenant.id, name: 'Property enquiry', status: 'PUBLISHED', category: 'LEAD_GENERATION', definition: { version: '7.1', screens: [] } },
      { tenant_id: tenant.id, name: 'Site-visit booking', status: 'DRAFT',   category: 'APPOINTMENT_BOOKING', definition: { version: '7.1', screens: [] } },
    ]),
  })
  await rest('/wa_qr_codes', {
    method: 'POST',
    body: JSON.stringify([
      { tenant_id: tenant.id, code: 'site-visit-poster',  url: 'https://wa.me/919876543210?text=I%20want%20a%20site%20visit', prefilled_message: 'I want a site visit', uses: 47 },
      { tenant_id: tenant.id, code: 'newspaper-ad-q4',    url: 'https://wa.me/919876543210?text=Saw%20your%20Times%20ad', prefilled_message: 'Saw your Times ad', uses: 312 },
    ]),
  })
  await rest('/wa_business_profiles', {
    method: 'POST',
    body: JSON.stringify({
      tenant_id: tenant.id,
      about: "Bangalore's premium real-estate agency since 2015",
      description: 'Acme Realty helps you find your next home, plot, or commercial space in Bangalore. WhatsApp us anytime!',
      email: 'hello@acme.in',
      websites: ['https://acme.in'],
      vertical: 'Professional Services',
      address: 'No. 42, MG Road, Bangalore 560001',
    }),
  })

  // 3.15 IG posts + comment rules
  await rest('/ig_posts', {
    method: 'POST',
    body: JSON.stringify([
      { tenant_id: tenant.id, type: 'image', caption: '✨ New listing — 2BHK at Sky Tower. DM "INFO" for details.', media_urls: ['https://placehold.co/600x600/E4405F/white?text=Sky+Tower'],  status: 'published', published_at: new Date(now - 86400000 * 3).toISOString(), scheduled_at: null },
      { tenant_id: tenant.id, type: 'reel',  caption: "Inside our latest 3BHK 🏠 Tag a friend who's house-hunting!",   media_urls: ['https://placehold.co/600x1080/8b5cf6/white?text=Reel'],     status: 'scheduled', published_at: null,                                       scheduled_at: new Date(now + 86400000).toISOString() },
    ]),
  })
  await rest('/ig_comment_rules', {
    method: 'POST',
    body: JSON.stringify([
      { tenant_id: tenant.id, name: 'Auto-DM price seekers', trigger_keywords: ['price','cost','rate'], match_kind: 'contains', reply_text: 'Sent you a DM with the price!', auto_dm_text: 'Hi! The price for this listing is mentioned in the carousel. Want a virtual tour?', enabled: true, fired_count: 23 },
    ]),
  })

  // 3.16 Meta Ads
  const [adAcc] = await rest('/meta_ad_accounts', {
    method: 'POST',
    body: JSON.stringify({ tenant_id: tenant.id, ad_account_id: 'act_123456789', name: 'Acme Realty Ads', currency: 'INR' }),
  })
  await rest('/meta_ad_campaigns', {
    method: 'POST',
    body: JSON.stringify([
      { tenant_id: tenant.id, ad_account_id: adAcc.ad_account_id, meta_campaign_id: '120000123456', name: 'CTWA · Diwali offer', objective: 'OUTCOME_ENGAGEMENT', destination: 'whatsapp', status: 'ACTIVE', daily_budget: 1500 },
      { tenant_id: tenant.id, ad_account_id: adAcc.ad_account_id, meta_campaign_id: '120000123457', name: 'IG DM · Premium Plots', objective: 'OUTCOME_ENGAGEMENT', destination: 'instagram_dm', status: 'PAUSED', daily_budget: 800 },
    ]),
  })
  await rest('/meta_audiences', {
    method: 'POST',
    body: JSON.stringify([
      { tenant_id: tenant.id, ad_account_id: adAcc.ad_account_id, meta_audience_id: 'aud_1001', name: 'Lead Nurture · CRM',   type: 'CUSTOM',    source: 'crm',           size_estimate: 1240, status: 'READY' },
      { tenant_id: tenant.id, ad_account_id: adAcc.ad_account_id, meta_audience_id: 'aud_1002', name: 'Lookalike · Premium', type: 'LOOKALIKE', source: 'lookalike:1001', size_estimate: 95000, status: 'PROCESSING' },
    ]),
  })

  // 3.17 Welcome notifications for the owner
  const eventTypes = await rest('/notification_event_types?select=key')
  const evtKeys = eventTypes.map(e => e.key)
  const notifs = [
    { event_key: 'system.platform_announcement', title: 'Welcome to Frequency!',              body: 'Your Acme Realty workspace is ready. Connect your apps from the sidebar to get started.', severity: 'info',    link: null },
    { event_key: 'broadcast.completed',          title: 'Broadcast "Diwali Offer" finished',  body: '480 sent · 472 delivered · 84 replied',                                                       severity: 'success', link: '/channels/whatsapp/broadcasts' },
    { event_key: 'lead.new',                     title: 'New lead: Rohit Singh',              body: 'From Instagram comment automation',                                                           severity: 'info',    link: '/contacts' },
    { event_key: 'team.invite_accepted',         title: 'Sneha Gupta joined your team',       body: 'As Analyst',                                                                                  severity: 'success', link: '/settings/team' },
  ].filter(n => evtKeys.includes(n.event_key))
  await rest('/notifications', {
    method: 'POST',
    body: JSON.stringify(notifs.map(n => ({ ...n, tenant_id: tenant.id, recipient_user_id: ownerId, data: {} }))),
  })

  // 3.17b Workflows — sample drafts + active automations
  await rest('/workflows', {
    method: 'POST',
    body: JSON.stringify([
      {
        user_id: ownerId, tenant_id: tenant.id, name: 'Welcome new lead',
        description: 'Send welcome WhatsApp + add to Sales Manager queue',
        status: 'live', intent_text: 'When a new lead comes in, send welcome and notify sales manager',
        nodes: [
          { id: 'trigger',  type: 'lead_added',     label: 'New lead added',                 config: {} },
          { id: 'wa_send',  type: 'send_template',  label: 'Send welcome template',         config: { template_name: 'welcome', template_params: ['{{trigger.contact.name}}'] } },
          { id: 'notify',   type: 'assign_agent',   label: 'Assign to Sales Manager',       config: { role: 'sales_manager' } },
        ],
        integrations: ['whatsapp'],
        stats: { sent: 248, replied: 92, converted: 31, revenue: 124000, conversionRate: 12.5 },
      },
      {
        user_id: ownerId, tenant_id: tenant.id, name: 'Site visit reminder',
        description: '24h before booked site visit, send WA reminder + add to Google Calendar',
        status: 'live', intent_text: 'Day before site visit reminder via WhatsApp + sync to calendar',
        nodes: [
          { id: 'trigger',  type: 'scheduled',         label: '24h before site_visit_at',  config: { offset_hours: -24 } },
          { id: 'wa_send',  type: 'send_template',     label: 'Send reminder template',     config: { template_name: 'site_visit_confirm' } },
          { id: 'cal',      type: 'create_calendar_event', label: 'Add to Google Calendar', config: {} },
        ],
        integrations: ['whatsapp', 'google_calendar'],
        stats: { sent: 156, replied: 134, converted: 89, revenue: 0, conversionRate: 57.0 },
      },
      {
        user_id: ownerId, tenant_id: tenant.id, name: 'Payment follow-up sequence',
        description: 'Razorpay payment-link → 3 follow-ups if unpaid in 24/48/72h',
        status: 'live', intent_text: 'Send Razorpay link, follow up 3 times if not paid',
        nodes: [
          { id: 'trigger',  type: 'tag_added',                  label: 'Tag "booked"',                config: { tag: 'booked' } },
          { id: 'rzp',      type: 'razorpay_create_payment_link', label: 'Create payment link',     config: { amount: 25000 } },
          { id: 'send1',    type: 'send_template',              label: 'Send link (immediate)',     config: { template_name: 'payment_link' } },
          { id: 'wait1',    type: 'wait_delay',                 label: 'Wait 24h',                   config: { delay_minutes: 1440 } },
          { id: 'send2',    type: 'send_template',              label: 'Reminder #1 (if unpaid)',   config: { template_name: 'payment_reminder' } },
        ],
        integrations: ['whatsapp', 'razorpay'],
        stats: { sent: 78, replied: 42, converted: 38, revenue: 950000, conversionRate: 48.7 },
      },
      {
        user_id: ownerId, tenant_id: tenant.id, name: 'AI auto-reply (off-hours)',
        description: 'Outside business hours, Claude AI replies with pricing + brochure link',
        status: 'draft', intent_text: 'AI reply outside 9am-6pm with pricing info',
        nodes: [
          { id: 'trigger', type: 'inbox_message',     label: 'Inbound WhatsApp message',  config: {} },
          { id: 'cond',    type: 'condition_variable', label: 'Outside 9-6?',              config: { variable: 'now.hour', operator: 'not_between', values: [9, 18] } },
          { id: 'ai',      type: 'run_ai_responder',  label: 'Claude reply',              config: { system_prompt: 'You are Acme Realty assistant. Reply with pricing + brochure URL.' } },
        ],
        integrations: ['whatsapp'],
        stats: { sent: 0, replied: 0, converted: 0, revenue: 0, conversionRate: 0 },
      },
    ]),
  })

  // 3.18 Platform announcement
  await rest('/platform_announcements', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Telegram Mini Apps now in beta',
      body: 'Build inline web apps that launch inside Telegram. See the Mini Apps page under Telegram in your sidebar.',
      severity: 'info', created_by: superAdminId,
    }),
  })

  ok(`Seeded ${contactsList.length} contacts, ${messages.length} messages, 3 broadcasts, 1 campaign, 3 catalog products, 2 flows, 2 QR codes, IG posts, Meta Ads campaigns, audiences, ${notifs.length} notifications`)

  return { ownerId, ownerEmail: 'priya@acme.in', teamUsers, tenantId: tenant.id }
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Frequency — Flush + Comprehensive Seed')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  await flush()
  const superId = await seedSuperAdmin()
  const tenant = await seedTenant(superId)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  ✅ DONE — Login credentials')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log()
  console.log('  ┌──────────────────────────────────────────────────────────────────────┐')
  console.log('  │ Role               │ Email                  │ Password    │ Path     │')
  console.log('  ├──────────────────────────────────────────────────────────────────────┤')
  console.log('  │ Platform Owner     │ owner@frequency.in     │ Owner@2026  │ /admin/auth │')
  console.log('  │ Tenant Owner       │ priya@acme.in          │ Owner@2026  │ /auth    │')
  console.log('  │ Workspace Admin    │ rohan@acme.in          │ Member@2026 │ /auth    │')
  console.log('  │ Sales Manager      │ ananya@acme.in         │ Member@2026 │ /auth    │')
  console.log('  │ Sales Rep          │ arjun@acme.in          │ Member@2026 │ /auth    │')
  console.log('  │ Marketing Manager  │ meera@acme.in          │ Member@2026 │ /auth    │')
  console.log('  │ Support Agent      │ kunal@acme.in          │ Member@2026 │ /auth    │')
  console.log('  │ Analyst            │ sneha@acme.in          │ Member@2026 │ /auth    │')
  console.log('  └──────────────────────────────────────────────────────────────────────┘')
  console.log()
  console.log('  Tenant     : Acme Realty Pvt Ltd  (id: ' + tenant.tenantId + ')')
  console.log('  Plan       : Growth (active subscription)')
  console.log('  Connected  : WhatsApp · Instagram · Telegram · Meta Ads · Razorpay · Shopify · Google Sheets / Drive / Calendar')
  console.log('  Sample data: 10 contacts · 24 messages · 3 broadcasts · 1 campaign · 3 catalog products · 2 flows · 2 QR codes · 2 IG posts · 2 Meta Ads campaigns · 2 audiences · 4 notifications · 1 announcement')
  console.log()
}

main().catch(err => {
  console.error('\n❌ Seed failed:', err.message)
  process.exit(1)
})
