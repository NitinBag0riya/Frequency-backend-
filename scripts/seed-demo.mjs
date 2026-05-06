// seed-demo.mjs — seeds 3 demo accounts with full realistic data
// node scripts/seed-demo.mjs

const SUPABASE_URL = 'https://yiicpndeggaedxobyopu.supabase.co'
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpaWNwbmRlZ2dhZWR4b2J5b3B1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzcxODU2OSwiZXhwIjoyMDkzMjk0NTY5fQ.lVLB6F3k7_MnPmqD55PNuRtIKDErF333ni94yGpwkS4'

// Demo accounts — share these with the user
// admin@Frequency   / Demo@123456  → full admin
// agent@Frequency   / Demo@123456  → agent (can view/reply, no settings)
// viewer@Frequency  / Demo@123456  → read-only

const META_TOKEN = 'EAAM7HgH6VvwBRE0ZCr2DxOjeQyVP6KiyVN93kaDasQiVKrwaTId1nFE0v8Sz3Y5VAQGvEGUGSzDNBXtTQeEgdMSKcOXxTdcjpqtW8GW8jq69hUZCmBNN1BLDiTNmrxQO4yjOLE4n8n3ZBZCCj76ieHYrg7rdYWtHlHHZBCZAlxWTN0MKZArqB78kGtzO8pngZDZD'

const REST = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

async function rest(method, path, body, extra = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: { ...REST, ...extra },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) { const t = await r.text(); throw new Error(`${method} ${path} → ${r.status}: ${t}`) }
  const text = await r.text()
  return text ? JSON.parse(text) : null
}

async function authAdmin(method, path, body) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    method,
    headers: REST,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) { const t = await r.text(); throw new Error(`auth ${method} ${path} → ${r.status}: ${t}`) }
  return r.json()
}

// ── Create or update an auth user, return their id ─────────────────────────
async function upsertAuthUser(email, password, fullName) {
  // Fetch all users (up to 1000) and search client-side — the email query param
  // is not reliably supported across all Supabase versions
  let page = 1
  while (true) {
    const { users } = await authAdmin('GET', `/users?page=${page}&per_page=100`)
    if (!users?.length) break
    const match = users.find(u => u.email === email)
    if (match) {
      await authAdmin('PUT', `/users/${match.id}`, { password, email_confirm: true })
      console.log(`✓ Updated user: ${email} (${match.id})`)
      return match.id
    }
    if (users.length < 100) break
    page++
  }
  const created = await authAdmin('POST', '/users', {
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  console.log(`✓ Created user: ${email} (${created.id})`)
  return created.id
}

// ── Tenant ─────────────────────────────────────────────────────────────────
async function upsertTenant(adminUserId) {
  // Check by owner first
  const existing = await rest('GET', `/tenants?user_id=eq.${adminUserId}&select=id&limit=1`)
  if (existing?.length) { console.log('✓ Tenant exists:', existing[0].id); return existing[0].id }

  // Check by WABA id (might be owned by old user)
  const byWaba = await rest('GET', `/tenants?waba_id=eq.721735523894042&select=id,user_id&limit=1`)
  if (byWaba?.length) {
    const tenantId = byWaba[0].id
    // Re-assign to admin user
    await rest('PATCH', `/tenants?id=eq.${tenantId}`, { user_id: adminUserId })
    console.log('✓ Re-assigned tenant to admin:', tenantId)
    return tenantId
  }

  const rows = await rest('POST', '/tenants', [{
    user_id: adminUserId,
    waba_id: '721735523894042',
    phone_number_id: '543913308793801',
    access_token: META_TOKEN,
    business_name: 'Frequency Demo Store',
    display_phone: '+91 98765 43210',
    status: 'active',
  }], { Prefer: 'return=representation' })
  console.log('✓ Created tenant:', rows[0].id)
  return rows[0].id
}

// ── User roles ─────────────────────────────────────────────────────────────
async function upsertUserRole(userId, tenantId, role) {
  // Delete any existing role for this user+tenant combo first (handles role changes)
  await rest('DELETE', `/user_roles?user_id=eq.${userId}&tenant_id=eq.${tenantId}`)
  await rest('POST', '/user_roles', [{ user_id: userId, tenant_id: tenantId, role }], { Prefer: 'return=representation' })
  console.log(`✓ Role set: ${role} for user ${userId}`)
}

// ── Contacts ───────────────────────────────────────────────────────────────
async function upsertContacts(adminUserId, tenantId) {
  const phones = ['919876543210','918765432109','917654321098','916543210987','915432109876','914321098765','913210987654','912109876543']
  await rest('DELETE', `/contacts?user_id=eq.${adminUserId}&phone=in.(${phones.join(',')})`)

  const contacts = [
    { user_id: adminUserId, tenant_id: tenantId, name: 'Rahul Sharma',  phone: '919876543210', tags: ['lead','premium'],  status: 'active',    bot_paused: false, attributes: { source: 'website',   city: 'Mumbai'    } },
    { user_id: adminUserId, tenant_id: tenantId, name: 'Priya Patel',   phone: '918765432109', tags: ['customer','vip'],  status: 'active',    bot_paused: false, attributes: { source: 'referral',  city: 'Delhi'     } },
    { user_id: adminUserId, tenant_id: tenantId, name: 'Amit Kumar',    phone: '917654321098', tags: ['lead'],            status: 'active',    bot_paused: false, attributes: { source: 'ad',        city: 'Bangalore' } },
    { user_id: adminUserId, tenant_id: tenantId, name: 'Sneha Reddy',   phone: '916543210987', tags: ['customer'],        status: 'active',    bot_paused: true,  attributes: { source: 'website',   city: 'Hyderabad' } },
    { user_id: adminUserId, tenant_id: tenantId, name: 'Vijay Nair',    phone: '915432109876', tags: ['opted_out'],       status: 'opted_out', bot_paused: false, attributes: {}                                        },
    { user_id: adminUserId, tenant_id: tenantId, name: 'Ananya Singh',  phone: '914321098765', tags: ['lead'],            status: 'active',    bot_paused: false, attributes: { source: 'instagram', city: 'Pune'      } },
    { user_id: adminUserId, tenant_id: tenantId, name: 'Karan Mehta',   phone: '913210987654', tags: ['customer','vip'],  status: 'active',    bot_paused: false, attributes: { source: 'referral',  city: 'Mumbai'    } },
    { user_id: adminUserId, tenant_id: tenantId, name: 'Divya Joshi',   phone: '912109876543', tags: ['customer'],        status: 'active',    bot_paused: false, attributes: { source: 'website',   city: 'Chennai'   } },
  ]
  await rest('POST', '/contacts', contacts)
  console.log(`✓ Seeded ${contacts.length} contacts`)
  return await rest('GET', `/contacts?user_id=eq.${adminUserId}&select=id,name,phone`)
}

// ── WA Templates ──────────────────────────────────────────────────────────
async function upsertTemplates(adminUserId) {
  const names = ['welcome_new_customer','order_confirmed','cart_recovery','flash_sale','delivery_update','feedback_request']
  await rest('DELETE', `/wa_templates?user_id=eq.${adminUserId}&name=in.(${names.join(',')})`)

  const now = Date.now()
  const t = (name, cat, status, header, body, footer, buttons, variables, daysAgo) => ({
    user_id: adminUserId, name, category: cat, language: 'en',
    status, header, body, footer, buttons, variables,
    created_at: new Date(now - daysAgo * 86400e3).toISOString(),
  })

  const templates = [
    t('welcome_new_customer', 'utility', 'approved',
      { type: 'text', text: 'Welcome to {{1}}! 🎉' },
      'Hi {{2}}, thank you for joining us! Browse our catalog and enjoy FREE delivery on your first order. Use code WELCOME10 for 10% off.',
      'Reply STOP to opt out',
      [{ type: 'url', text: 'Shop Now', url: 'https://store.example.com' }],
      ['Frequency Store', 'Rahul'], 10),

    t('order_confirmed', 'utility', 'approved',
      { type: 'text', text: 'Order #{{1}} Confirmed ✅' },
      'Hi {{2}}, your order for ₹{{3}} has been confirmed! Expected delivery: {{4}}. Track your order anytime.',
      'Frequency Store',
      [{ type: 'url', text: 'Track Order', url: 'https://track.example.com/{{1}}' }, { type: 'phone_number', text: 'Call Support', phone_number: '+919876543210' }],
      ['ORD-4521', 'Priya', '1,299', 'Tomorrow by 6 PM'], 8),

    t('cart_recovery', 'marketing', 'approved',
      { type: 'text', text: '🛒 You left something behind!' },
      'Hi {{1}}, you left {{2}} in your cart. Complete your purchase and get 15% off with code SAVE15. Offer valid for 24 hours!',
      'Reply STOP to opt out',
      [{ type: 'quick_reply', text: 'Complete Order' }, { type: 'quick_reply', text: 'Not Interested' }],
      ['Amit', 'Premium Face Serum'], 6),

    t('flash_sale', 'marketing', 'approved',
      { type: 'text', text: '⚡ Flash Sale — {{1}} OFF!' },
      "Hi {{2}}! Our biggest sale of the year is LIVE. {{1}} off on everything for the next {{3}} hours. Don't miss out!",
      'Reply STOP to opt out',
      [{ type: 'url', text: 'Shop Sale', url: 'https://sale.example.com' }],
      ['40%', 'Sneha', '6'], 4),

    t('delivery_update', 'utility', 'approved',
      null,
      'Hi {{1}}, your order #{{2}} is out for delivery! 🚚 Our delivery partner will arrive between {{3}}. Please keep your phone handy.',
      'Frequency Store',
      [],
      ['Karan', 'ORD-5892', '2 PM – 5 PM'], 2),

    t('feedback_request', 'utility', 'pending',
      null,
      'Hi {{1}}, how was your experience with order #{{2}}? Your feedback helps us improve. Rate us 1–5 ⭐',
      'Reply STOP to opt out',
      [{ type: 'quick_reply', text: '⭐⭐⭐⭐⭐ Excellent' }, { type: 'quick_reply', text: '😐 Average' }, { type: 'quick_reply', text: '👎 Poor' }],
      ['Divya', 'ORD-6103'], 1),
  ]

  await rest('POST', '/wa_templates', templates)
  console.log(`✓ Seeded ${templates.length} WA templates`)
}

// ── Broadcasts ─────────────────────────────────────────────────────────────
async function upsertBroadcasts(adminUserId, tenantId) {
  const names = ['May Diwali Promo','Cart Recovery Wave 1','New Product Launch','VIP Reactivation','Flash Sale Blast','Welcome Series']
  await rest('DELETE', `/broadcasts?user_id=eq.${adminUserId}&name=in.(${names.map(n => `"${n}"`).join(',')})`)

  const now = Date.now()
  const b = (name, tpl, status, audience, stats, variable_map, sent_at, scheduled_at) => ({
    user_id: adminUserId, tenant_id: tenantId, name, template_name: tpl, status, audience, stats, variable_map,
    sent_at: sent_at ?? null, scheduled_at: scheduled_at ?? null,
  })

  const broadcasts = [
    b('May Diwali Promo',     'flash_sale',           'sent',      { all: true },                { sent: 1240, delivered: 1198, read: 876, replied: 43, failed: 42 }, { '1': '40%', '2': '{{contact.name}}', '3': '6' },         new Date(now - 7*86400e3).toISOString(),  null),
    b('Cart Recovery Wave 1', 'cart_recovery',        'sent',      { tags: ['lead'] },           { sent: 312,  delivered: 298,  read: 201, replied: 18, failed: 14 }, { '1': '{{contact.name}}', '2': 'Premium Face Serum' },   new Date(now - 3*86400e3).toISOString(),  null),
    b('New Product Launch',   'flash_sale',           'scheduled', { all: true },                { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 },           { '1': '30%', '2': '{{contact.name}}', '3': '12' },       null, new Date(now + 2*86400e3).toISOString()),
    b('VIP Reactivation',     'welcome_new_customer', 'draft',     { tags: ['customer','vip'] }, { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 },           {},                                                        null, null),
    b('Flash Sale Blast',     'flash_sale',           'sent',      { all: true },                { sent: 890, delivered: 861, read: 612, replied: 29, failed: 29 },   { '1': '25%', '2': '{{contact.name}}', '3': '48' },       new Date(now - 14*86400e3).toISOString(), null),
    b('Welcome Series',       'welcome_new_customer', 'sent',      { tags: ['lead'] },           { sent: 156, delivered: 152, read: 89,  replied: 12, failed: 4 },    { '1': 'Frequency Store', '2': '{{contact.name}}' },   new Date(now - 20*86400e3).toISOString(), null),
  ]

  await rest('POST', '/broadcasts', broadcasts)
  console.log(`✓ Seeded ${broadcasts.length} broadcasts`)
}

// ── Messages ───────────────────────────────────────────────────────────────
async function upsertMessages(tenantId, contacts) {
  await rest('DELETE', `/messages?tenant_id=eq.${tenantId}`)

  const now = Date.now()
  const msgs = []
  const convos = [
    { phone: '919876543210', thread: [
      { dir: 'inbound',  text: 'Hi! I saw your ad on Instagram. What products do you offer?',                          ago: 3600 },
      { dir: 'outbound', text: 'Hello Rahul! We offer premium skincare products. Would you like to see our catalog?', ago: 3500 },
      { dir: 'inbound',  text: 'Yes please! Also what are your delivery charges?',                                     ago: 3000 },
      { dir: 'outbound', text: 'Free delivery on orders above ₹499. Here\'s our catalog link 🛍️',                   ago: 2900 },
      { dir: 'inbound',  text: 'Great! I\'ll place an order today.',                                                   ago: 1800 },
      { dir: 'outbound', text: 'Awesome! Let me know if you need any help 😊',                                         ago: 1700 },
    ]},
    { phone: '918765432109', thread: [
      { dir: 'inbound',  text: 'When will my order #ORD-4521 be delivered?',                                 ago: 7200 },
      { dir: 'outbound', text: 'Hi Priya! Your order is out for delivery and will arrive by 6 PM today.',   ago: 7100 },
      { dir: 'inbound',  text: 'Thank you! 😊',                                                              ago: 7000 },
    ]},
    { phone: '917654321098', thread: [
      { dir: 'inbound',  text: 'Do you have any offers running this week?',                                  ago: 86400 },
      { dir: 'outbound', text: 'Yes Amit! Use code SAVE20 for 20% off on all orders till Sunday!',         ago: 86300 },
      { dir: 'inbound',  text: 'Amazing! Will use it. Thanks',                                               ago: 86200 },
    ]},
    { phone: '916543210987', thread: [
      { dir: 'inbound',  text: 'I have a complaint. My package arrived damaged.',                            ago: 14400 },
      { dir: 'outbound', text: 'We are really sorry Sneha! Please share a photo of the damage.',            ago: 14300 },
      { dir: 'inbound',  text: 'Sending photo now',                                                         ago: 14200 },
      { dir: 'outbound', text: 'Thank you! We will initiate a replacement within 24 hours.',                ago: 14000 },
      { dir: 'outbound', text: 'Replacement dispatched 🚚 Tracking: TRK-2891',                              ago: 3600  },
    ]},
    { phone: '914321098765', thread: [
      { dir: 'inbound',  text: 'Hi, I want to know more about your VIP membership',                                                              ago: 600 },
      { dir: 'outbound', text: 'Hi Ananya! Our VIP membership gives early access to sales, free returns & personal stylist. Interested?', ago: 500 },
      { dir: 'inbound',  text: 'Yes! How do I sign up?',                                                                                          ago: 400 },
    ]},
    { phone: '913210987654', thread: [
      { dir: 'outbound', text: 'Hi Karan! Exclusive VIP offer — 50% off your next purchase. Valid till midnight! 🎁', ago: 1200 },
      { dir: 'inbound',  text: 'This is amazing! Just ordered ₹2500 worth. Thanks!',                                  ago: 900  },
    ]},
    { phone: '912109876543', thread: [
      { dir: 'outbound', text: 'Hi Divya! How was your experience with order #ORD-6103? Rate us 1-5 ⭐',  ago: 43200 },
      { dir: 'inbound',  text: '⭐⭐⭐⭐⭐ Excellent! Loved the product and fast delivery.',             ago: 40000 },
      { dir: 'outbound', text: 'Thank you so much Divya! Your feedback means a lot 🙏',                   ago: 39500 },
    ]},
  ]

  for (const convo of convos) {
    const contact = contacts.find(c => c.phone === convo.phone)
    if (!contact) continue
    for (const m of convo.thread) {
      msgs.push({
        tenant_id: tenantId,
        contact_phone: convo.phone,
        direction: m.dir,
        content: { type: 'text', text: m.text },
        status: m.dir === 'outbound' ? 'delivered' : 'read',
        created_at: new Date(now - m.ago * 1000).toISOString(),
      })
    }
  }

  await rest('POST', '/messages', msgs)
  console.log(`✓ Seeded ${msgs.length} messages (${convos.length} conversations)`)
}

// ── Campaigns ──────────────────────────────────────────────────────────────
async function upsertCampaigns(adminUserId, tenantId) {
  const names = ['Lead Nurture Drip','Post-Purchase Review','Cart Recovery Sequence','VIP Loyalty Program','Re-engagement 30-Day']
  await rest('DELETE', `/campaigns?user_id=eq.${adminUserId}&name=in.(${names.map(n => `"${n}"`).join(',')})`)

  const campaigns = [
    { user_id: adminUserId, tenant_id: tenantId, name: 'Lead Nurture Drip',      description: '5-touch drip for new website leads',       type: 'drip',      status: 'active',  stats: { enrolled: 248, active: 112, converted: 34,  revenue: 68000 } },
    { user_id: adminUserId, tenant_id: tenantId, name: 'Post-Purchase Review',   description: 'Ask for Google review 3 days after order',  type: 'triggered', status: 'active',  stats: { enrolled: 891, active: 45,  converted: 221, revenue: 0     } },
    { user_id: adminUserId, tenant_id: tenantId, name: 'Cart Recovery Sequence', description: '3-message cart abandonment recovery',      type: 'drip',      status: 'paused',  stats: { enrolled: 134, active: 0,   converted: 22,  revenue: 44000 } },
    { user_id: adminUserId, tenant_id: tenantId, name: 'VIP Loyalty Program',    description: 'Exclusive offers for repeat customers',    type: 'drip',      status: 'draft',   stats: { enrolled: 0,   active: 0,   converted: 0,   revenue: 0     } },
    { user_id: adminUserId, tenant_id: tenantId, name: 'Re-engagement 30-Day',   description: 'Win back contacts silent for 30+ days',   type: 'triggered', status: 'active',  stats: { enrolled: 67,  active: 41,  converted: 8,   revenue: 12400 } },
  ]

  await rest('POST', '/campaigns', campaigns)
  console.log(`✓ Seeded ${campaigns.length} campaigns`)
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🌱 Seeding demo accounts...\n')

  try {
    // 1. Create / reset auth users
    const adminId  = await upsertAuthUser('admin@Frequency',  'Demo@123456', 'Demo Admin')
    const agentId  = await upsertAuthUser('agent@Frequency',  'Demo@123456', 'Demo Agent')
    const viewerId = await upsertAuthUser('viewer@Frequency', 'Demo@123456', 'Demo Viewer')

    // 2. Tenant (owned by admin)
    const tenantId = await upsertTenant(adminId)

    // 3. RBAC — assign roles
    await upsertUserRole(adminId,  tenantId, 'admin')
    await upsertUserRole(agentId,  tenantId, 'agent')
    await upsertUserRole(viewerId, tenantId, 'viewer')

    // 4. Data
    const contacts = await upsertContacts(adminId, tenantId)
    await upsertTemplates(adminId)
    await upsertBroadcasts(adminId, tenantId)
    await upsertMessages(tenantId, contacts)
    await upsertCampaigns(adminId, tenantId)

    console.log('\n✅ Seed complete!\n')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('Demo accounts (password: Demo@123456)')
    console.log('  admin@Frequency   → Admin  (full access)')
    console.log('  agent@Frequency   → Agent  (inbox/contacts, no settings)')
    console.log('  viewer@Frequency  → Viewer (read-only)')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
  } catch (e) {
    console.error('\n❌ Seed failed:', e.message)
    process.exit(1)
  }
}

main()
