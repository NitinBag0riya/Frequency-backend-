# Frequency · Product Roadmap (Detailed)

**Last updated**: 2026-05-19
**Audience**: founder, engineering leads, product, GTM
**Companion**: `ROADMAP_CHECKLIST.md` (1-page print version)

---

## 1. Executive summary

Frequency is a multi-tenant, multi-channel customer-conversations platform with a white-label agency layer. We compete with DoubleTick, Wati, AiSensy, and Interakt in the India WhatsApp-Business-API SaaS market.

**Where we win today** (already shipped):
- Multi-channel (WA + Instagram + Telegram) where competitors are WA-only
- Full agency / white-label platform with revshare ledger + credit-as-refund settlement (unique in the India market)
- DPDPA Privacy Center + breach notifications + data residency as first-class features
- Operational maturity: webhook dead-letter + replay, demo data, audit-hardened race-safe revshare flow

**Where we're being beaten today** (what this roadmap addresses):
- Inbox agent productivity (quick replies, internal notes) — competitors have it, we don't
- AI quality (knowledge-base RAG, conversation summaries) — competitors trained on tenant docs, ours is general-purpose
- Enterprise compliance (PII masking) — legal blocker for BFSI / healthcare / fintech
- Manager visibility (SLA tracking, agent KPIs) — operational table-stakes
- WhatsApp-native commerce (catalog + cart + delivery + khaata) — DoubleTick captures non-Shopify SMB; we don't
- Native mobile (real screens, not webview) — agents work on phones; webview hurts adoption

**Why this order**: weeks 1–2 unlock both adoption (agents) and a new buyer segment (BFSI). Weeks 3–5 close the AI + operational gap. Weeks 6–10 unlock the largest TAM segment in India (kirana / dairy / grocery / services). Weeks 11–14 fix the mobile experience that field agents and small-shop owners require.

---

## 2. Current state — what's shipped

### 2.1 Inbox & conversation management
- **Multi-channel inbox** — WA, Instagram DMs, Telegram (competitors are WA-only)
- **Voice-note transcripts** — Whisper-style ASR auto-runs on every voice message
- **WhatsApp Calling** — incoming + outgoing, recording + transcripts
- **Conversation routing** — auto-assignment rules + round-robin
- **Approval rules** — gate AI replies and certain workflow actions behind agent review

### 2.2 Workflows & automation
- **No-code workflow engine** — drag-drop nodes including AI, branching, templates, delays, HTTP calls
- **Curated workflow templates library** — 11 live templates spanning IG/WA/Shopify use cases (migration 091 cleaned the unrunnable ones)
- **Approval rules** for sensitive actions

### 2.3 Commerce & payments
- **Razorpay native billing** — not "an integration" but first-class; subscriptions, refunds, GST invoices, all the Indian compliance hooks (HSN/SAC, CGST/SGST/IGST math, FY-aware invoice numbering)
- **Shopify connector** — catalog sync + order webhooks + abandoned cart triggers
- **CTWA attribution** — Click-to-WhatsApp ads end-to-end campaign tracking

### 2.4 Analytics & compliance
- **Tenant Analytics** — message volumes, broadcasts performance, workflow stats
- **Platform Analytics** (super-admin) — total tenants/agencies, MRR sparkline (30-day), recent signups feed
- **DPDPA Privacy Center** — consent timeline, data subject requests (DSR), data residency toggle
- **Breach notifications** — DPDPA §8(6) 72-hour notification workflow with super-admin console
- **Webhook dead-letter + replay** — failed deliveries surface in super-admin console with one-click replay

### 2.5 Multi-tenant / agency platform
- **Agency console** (`/agency/:slug/*`) — dedicated layout + sidebar
  - Co-branded header: "{Agency Name} × Frequency"
  - Dashboard: animated wave hero, KPI strip (sub-accounts X/Y, pending payout, paid YTD, last payout), tinted Quick Actions (Invite tenant / Manage billing / Revshare ledger / Team / Settings)
  - Managed workspaces grid with Open + Inbox + Billing quick actions, plus tenant owner email/name visible
  - Recent revshare panel + Recent settlements + Plan utilization card
- **Agency Settings page** — Identity (name + immutable slug), Defaults (revshare % + agency_paid_by_default), Danger zone (slug-confirmation archive), sticky save bar on dirty
- **Sub-account invite + accept** — HMAC-signed tokens, at-limit detection, "Upgrade plan" CTA when over trial cap
- **Tenant-context banner** — when an agency owner views a managed tenant's workspace, top brand-emerald strip says "Managed workspace · {Tenant} is part of {Agency}" with one-click "Back to {Agency}" button
- **Revshare credit-as-refund** — instead of RazorpayX payouts, the agency's accrued revshare is applied as a partial refund on their next platform-fee charge. Race-safe via partial unique index on `(agency_id, razorpay_payment_id)`, insert-first protocol, refundable-balance ceiling check, structured `[ALERT_REVSHARE_PARTIAL_FAILURE]` log on inconsistency.
- **Agency signup page** (`/agency-signup`) — dedicated landing + form, `pending_agency_name` stashed on auth.users metadata for post-confirmation roundtrip
- **Platform console** (`/naruto`, super-admin) — Tenants | Agencies tab toggle, per-tab pagination, AgencyCard with owner email + MRR + sub-account count
- **Super-admin can view any agency** — `AgencyShell` falls back to `/api/super-admin/agencies/by-slug/:slug` when the caller isn't a member; banner appears only when actually resolved via that path

### 2.6 CRM & contacts
- **Contacts + Segments** — tenant-scoped, with bulk CSV/XLSX import + saved segment definitions
- **Lead tables** — flexible custom-schema tables with **ingest tokens** (unique URL per tenant, third parties can POST leads)
- **Sales Pipeline** — Kanban with custom stages, deal cards, activity timeline (merged from the legacy "My Queue" flow)
- **Workflow trigger from leads** — every lead insert can trigger a workflow

### 2.7 Deploy & ops
- **FE on Vercel** project `frequency-fe` — `stage` branch auto-deploys to `beta.getfrequency.app`, `main` to apex
- **BE on Fly.io** `bom` region (Mumbai) — GitHub Action `Deploy to Fly.io` on push to `stage`/`main`
- **Supabase** project `yiicpndeggaedxobyopu` — current schema at migration 092
- **Demo data** seeded for testing: `demo-agency@frequency.in` / `Demo@2026!`, owns "Demo Growth Studio" agency + "Demo Tenant Alpha" + "Demo Tenant Beta"

---

## 3. Production-readiness hardening (just completed)

The 2026-05-19 security + code-review audits surfaced 4 P0s on the revshare flow plus several P1s. All shipped on `stage`:

| ID | Issue | Fix |
|---|---|---|
| Sec P0 | TOCTOU race in revshare credit (ILIKE on notes column before insert) | Migration 092 added partial unique index on `(agency_id, razorpay_payment_id)`. Helper rewritten to insert-first; ON CONFLICT short-circuits races |
| Sec P0 | Refund amount used stale webhook-payload value | New `fetchPayment()` returns live `amount − amount_refunded`; helper caps credit at the live remaining balance |
| Sec P0 | Refund issued before DB writes → retries re-refunded | Insert-first protocol means the dedup row exists before Razorpay is called |
| Sec P0 | `AGENCY_INVITE_SECRET` fell back to `SUPABASE_SERVICE_ROLE_KEY` | Production now requires explicit env var (≥32 chars); fails 500 at first invite mint otherwise |
| Sec P1 | `/super-admin/agencies` pageSize 100 → fan-out auth.admin.getUserById | Capped at 25 |
| Sec P1 | `/super-admin/mrr-trend` full-table scan | Pre-filter to subs that could have been active in window, 50k row hard cap, row-count log |
| Sec P2 | Slug input on `/by-slug/:slug` unvalidated | Regex-gated before DB hit |
| QA P1 | AgencyShell banner falsely claimed super-admin members weren't members | Now gates on `resolvedViaSuperFallback` flag, not `isSuper` |
| QA P1 | AgencyDashboardPage missing `.catch` on `revshareSummary` | All 5 parallel fetches have `.catch` fallbacks; partial-failure renders gracefully |
| QA P1 | AgencyManagementBanner refetched on every internal nav | Now depends on `activeTenantId` state synced via storage event |
| QA P1 | Refund-success-but-DB-fail had no surfacing | Structured `[ALERT_REVSHARE_PARTIAL_FAILURE]` log token with manual-fix instructions in payload |

---

## 4. Roadmap — 6 phases, ~14 weeks

### Phase 1 · Weeks 1–2 — Inbox quality + compliance unlock

Cheapest, highest-impact items. Both share inbox UI surface. Both unblock real customer concerns we've heard.

#### 1A · Quick Replies + Internal Notes + Pipeline tie-in (week 1)

**Quick Replies** — 3-tier library:
- **Workspace level** — admin-curated, used by entire org
- **Team level** — Sales / Support / Onboarding scope
- **Personal level** — each agent's snippets

**Composer UX**: type `/` opens picker. Top 3 suggestions are stage-aware: when the conversation's contact has a Pipeline deal in stage "Negotiation", "Discount approval" reply ranks first; deal in "Demo Booked" + customer said "thanks", "Confirm demo timing" ranks first.

**Variable interpolation** at insert time (not save time):
- `{{contact.first_name}}`, `{{contact.custom_field.<key>}}`
- `{{deal.title}}`, `{{deal.stage}}`, `{{deal.amount_inr | format_inr}}`
- `{{agent.name}}`, `{{agent.signature}}`
- `{{tenant.business_name}}`, `{{tenant.support_email}}`
- `{{razorpay.link(amount, ref)}}` — fresh payment link generated inline
- `{{khaata.balance(contact)}}` — current ledger balance (commerce feature)
- `{{date | format:'DD MMM'}}`

**Internal Notes** — attach to: conversation, specific message, deal card, contact profile. Composer has "Internal note" toggle; turns yellow, doesn't send to WhatsApp. `@agent_name` in body → in-app bell + push + email after 5 min if offline. Notes auto-appear in **deal-card timeline** so sales leads can review history without scrolling whole conversation. Stale-deal watcher: deal in non-terminal stage with no inbound/outbound for 72h → auto-note `@{deal.owner} stale — last action {date}`.

**Schema additions**:
```sql
quick_replies (id, tenant_id, scope, scope_target_id, title, body_template,
               hotkey, variables_required[], applicable_stages[],
               applicable_intents[], usage_count, last_used_at)
quick_reply_usage (id, quick_reply_id, conversation_id, agent_id, used_at, edited)
conversation_notes (id, tenant_id, target_type, target_id, body, mentions[],
                    attachments_json, visibility, created_by, resolved_at)
note_mentions (id, note_id, mentioned_user_id, notified_at, read_at, push_sent_at)
```

**Build cost**: ~1 week combined. Shares composer extension surface.

#### 1B · PII / Sensitive Data Masking (week 2, parallel to 1A)

**Detection layer**: Regex + small ML classifier for Aadhaar, PAN, bank account, IFSC, phone, email, DoB, policy #, transaction ID, OTPs. Optional doc-image detection via vision model (Anthropic) for ID photos.

**Per-role unmask**:
- Junior agent → masked at all times
- Senior agent → tap-to-unmask single field with reason logged
- Manager + compliance → permanent unmask permission

**Audit trail**: every unmask event → `pii_unmask_log (actor_id, conversation_id, message_id, field_type, reason, ip, user_agent, timestamp)`. DPDPA audit-ready out of the box.

**Tenant configuration**: per-tenant which field types to mask + which roles can unmask. Default-on for new tenants.

**Build cost**: ~1 week. Detector runs on message ingest (cached on message row); render layer reads `masked_render` boolean from request context.

**Unlocks**: BFSI / fintech / healthcare / insurance sales pipeline. Currently a hard "we cannot use you" objection on first demo.

---

### Phase 2 · Weeks 3–4 — AI Agent (simple 3-step UX)

**Page**: `/settings/ai-agent` · single scroll · three sections · zero tabs.

```
1. TEACH ME
   📄 Drop a PDF · 🌐 Paste a URL · ⌨ Type Q&A
   Shows "What I learned" — list of sources + chunk count + ✓ ready status
   Right-click any source → view chunks → inline edit if needed

2. TEST IT
   Inline chat box. Type a customer question, AI answers.
   Source citations show ("📎 From: Refund policy.pdf").
   👍 / 👎 buttons.
   👎 → modal "What should it have said?" → adds Q&A pair → re-tests.

3. TURN IT ON
   ● Toggle: AI is ON / OFF
   Mode: Always · After-hours only · When no agent available
   ☐ Agent must approve before sending (suggested-reply panel in inbox)
   [Save changes]
```

Everything technical hidden underneath:
- pgvector embeddings on `kb_chunks.embedding`
- Cosine retrieval (top-5) at inference; Anthropic with retrieved context
- Confidence scoring: ≥0.78 → confident reply; 0.55–0.78 → reply with "review this" flag; <0.55 → human handoff + "unanswered query" record
- Auto-publish on edit with 5-second undo toast
- Daily cluster job buckets unanswered queries; surfaces in `[History]` link as "Suggested additions"

**`[⚙ Advanced]`** link for power users:
- Chunk tagging
- Confidence threshold adjustment
- Connect Notion / Google Drive (vs upload)
- Multi-language tuning
- Webhook on low-confidence replies

**Schema**:
```sql
knowledge_bases (id, tenant_id, name, status='draft'|'live', current_version_id)
kb_versions (id, kb_id, version_number, published_at, published_by)
kb_sources (id, kb_id, type='pdf'|'url'|'qa'|'notion', source_meta, last_ingested_at)
kb_chunks (id, kb_version_id, source_id, text, tokens, tags[],
           embedding vector(1536), retrieval_count,
           thumbs_up, thumbs_down, manual_edit_at, needs_review)
kb_test_runs (id, kb_id, version_id, input_text, output_text, confidence,
              cited_chunk_ids[], agent_rating, created_by, created_at)
kb_inference_log (id, conversation_id, kb_version_id, query_embedding,
                  retrieved_chunks[], confidence, response_text, agent_overrode)
```

**Build cost**: ~2 weeks. We have Anthropic + Supabase already; need `pgvector` extension + the Knowledge Base UI surface + augment existing `ai_reply` workflow node.

**Goal**: non-technical tenant admin finishes setup in <5 minutes from first upload to live AI.

---

### Phase 3 · Week 5 — SLA Tracking + Breach Alerts

**Config (per tenant or per team)**:
- First-response target (e.g. 5 min on inbound)
- Total-resolution target (e.g. 24 h)
- Per channel (WA can be tighter than email)
- Working hours (don't count after-hours toward breach)

**Detection worker**: scans every open conversation every 30s; computes `now − last_inbound_at` and `now − last_outbound_at`. Emits `sla_breaches` row on threshold cross.

**Inbox surfaces**:
- Per-conversation column: green (well within SLA) · amber (≥80% of target) · red (breached)
- Sort by SLA risk → "show me what's about to break"

**Manager dashboard widget**:
- "Conversations approaching breach (next 30 min)" — sorted, with assigned agent
- "Breaches today" — grouped by agent, with breach duration
- Per-agent + per-team aggregate trends (% SLA met this week)

**Push notification**: Expo push on red threshold crossing → "You have a conversation breaching SLA in 30 min" with deep-link.

**Schema**:
```sql
sla_configs (id, tenant_id, team_id, channel, first_response_seconds,
             resolution_seconds, working_hours_json, paused boolean)
sla_breaches (id, conversation_id, type='first_response'|'resolution',
              target_seconds, actual_seconds, breached_at, breach_resolved_at,
              assigned_agent_id)
```

**Build cost**: ~1 week. Worker + schema + inbox column + dashboard widget + push notification wiring.

**Unlocks**: every team ≥ 3 agents. Managers literally can't run an inbox without this today.

---

### Phase 4 · Weeks 6–10 — WhatsApp Commerce + Delivery

This is the largest TAM unlock — Indian non-Shopify SMB (kirana, dairy, tiffin, vegetable vendor, salon, cook, tutor). Total addressable: ~2.5 crore vendors. Built in three halves over five weeks.

#### 4A · Order capture (weeks 6–7)

**Inbound modalities**:
- **Voice notes** → existing transcript pipeline → `commerce_order_capture` workflow node parses items
- **Photos of shopping lists** → Anthropic vision → extracted items
- **Text in Hindi/English code-switch** — "2 kilo aata" / "दो किलो आटा" / "wheat flour 2kg" all match the same item

**Catalog with no SKUs** — vendor reality:
- `catalog_items.alt_names text[]` — vendor adds variations casually
- Fuzzy + trigram + embedding fallback for "do kilo atta" → "Wheat flour 1kg" × 2
- Bulk-import from photo of vendor's price list (vision model)

**Confirmation flow** — WhatsApp interactive list message with order summary; Confirm / Edit / Cancel buttons.

**Schema**:
```sql
catalog_items (id, tenant_id, name, alt_names[], unit, price_paise,
               category, image_url, active, embedding vector(1536))
```

**Workflow node**: `commerce_order_capture` accepts inbound text/voice/image, returns items list, attaches to conversation.

#### 4B · Khaata settlement (week 8)

**Schema**:
```sql
khaata_accounts (id, tenant_id, contact_id, balance_paise, credit_limit_paise,
                 settlement_day, last_settled_at, trust_score)
khaata_transactions (id, account_id, conversation_id, message_id,
                     type='order'|'settlement'|'adjustment'|'refund',
                     items_json, amount_paise,
                     delivered_at, paid_at, razorpay_payment_id, notes)
standing_orders (id, account_id, items_json, frequency='daily'|'weekly'|'custom_dates',
                 skip_dates[], pause_from, pause_to, delivery_window)
monthly_settlements (id, account_id, period_start, period_end,
                     total_paise, paid_paise, razorpay_link_id, razorpay_payment_id,
                     status='pending'|'paid'|'overdue', reminder_sent_at[])
```

**Workflow nodes**:
- `khaata_add_transaction` — append + adjust balance
- `khaata_check_limit` — branch on credit-limit breach
- `commerce_aggregate_bill` — month-end cron: aggregate, render PDF, send Razorpay link
- `commerce_settlement_received` — Razorpay webhook → zero balance + receipt

**Settlement options**:
- Razorpay payment link (primary)
- UPI deep-link with auto-receipt
- Cash on delivery (vendor marks manually)
- Partial payment ("₹500 cash today, ₹2,920 pending")

**Trust scoring**: new customer credit_limit = ₹200; auto-bump to ₹500 after one on-time settlement, ₹2,000 after three. Configurable per vendor.

#### 4C · Delivery operations (weeks 9–10)

The half originally missed. Three actors, three surfaces.

**Vendor planning dashboard** (`/commerce/runs/today`):
- Today's run grouped by area, auto-route, optimal sequence
- Drag-reorder if vendor knows better
- **Print delivery sheet** (still 50% of Indian vendors prefer paper)
- Send sheet to delivery boy via WhatsApp (signed expiring link)
- Cash expected — running tally
- Reassign on the fly (sick → move 12 stops to another)

**Delivery-boy mobile-web** — no install, no login:
- Signed token in WhatsApp link, expires end-of-day
- 4-screen swipe interface (one stop at a time)
- Hindi/English toggle, big tap targets
- Per stop: photo proof + GPS snapshot + cash toggle + ✓ Delivered / ✕ Couldn't deliver
- Failure reasons: not home / address wrong / refused / no cash → branches into reschedule logic
- One-tap call customer + open in Maps

**Customer WhatsApp pings** (auto, via workflow):
- 3 stops away: "Your delivery is on the way 🛵 ETA ~15 min"
- Delivered: "Delivered ✓ [photo] Today: ₹240 · Tab: ₹847"
- Failed: "Couldn't deliver — try again at 7 PM? Reply YES / RESCHEDULE / SKIP"

**Schema**:
```sql
delivery_agents (id, tenant_id, name, phone, profile_photo_url,
                 active_areas[], active boolean)
delivery_runs (id, tenant_id, run_date, agent_id,
               status='planning'|'in_progress'|'completed'|'cancelled',
               total_stops, completed_stops, failed_stops,
               cash_expected_paise, cash_collected_paise, route_polyline, print_url)
delivery_stops (id, run_id, transaction_id, sequence, address, geo point,
                scheduled_window, eta_at, arrived_at, delivered_at, failed_at,
                failure_reason, cash_collected_paise, photo_proof_url,
                gps_at_delivery point, customer_note,
                status='pending'|'in_transit'|'delivered'|'failed'|'rescheduled')
delivery_attempts (id, stop_id, attempted_at, outcome, failure_reason)
```

**End-of-day cash reconciliation**: delivery boy returns → "₹1,840 expected, ₹1,720 actual, short by ₹120 (Sharma ji didn't pay)". Vendor's inbox shows the gap + auto-flags overdue tabs.

**Build cost**: ~5 weeks total (2 + 1 + 2). Delivery half is the moat — operational grunt that nobody else is building because it doesn't demo well in a 15-min sales call. But it replaces paper khaata + Slack-coordinated deliveries + cash-up math errors. Vendors will pay ₹999/month for that.

---

### Phase 5 · Weeks 11–14 — Native Mobile Screens

Replace `HostedScreen` webview wrappers with real React Native (Expo) for the three critical surfaces:

| Screen | What native unlocks |
|---|---|
| **Inbox list** | Pull-to-refresh, swipe actions, real long-press menus, offline list cache |
| **Conversation detail** | Native keyboard, offline draft save, photo/voice attach via system camera intent, system "share to Frequency" target, inline reply |
| **Notifications** | Real push that wakes device, native deep-links, inline reply from notification, badge counts |

Field-sales reps, delivery boys, small-shop owners work entirely on phones. The webview-based experience hurts adoption.

**Build cost**: ~4 weeks. We have the Expo skeleton + auth + tenant switcher; need to native-ize the 3 screens + push notification stack (Expo Push + Supabase realtime subscription).

---

## 5. Deferred items + reasoning

| Deferred | Why |
|---|---|
| **ISO 27001 / SOC 2 certification** | ₹15-25L + 6 months of audit work. DPDPA is sufficient for India SMB + mid-market. Defer until first ₹2Cr ARR. |
| **Custom dashboard / report builder** | Power-user feature. The canned views serve 90%. Build only after #1-6 are live and we have 100+ tenants asking. |
| **Multi-number per tenant** | Edge case — most tenants have one WABA. Workflow node can fake it via tenant cloning for the few that need it. |
| **Auto-retargeting missed campaigns** | Workflow can do this manually. No first-class UI competitors compete on yet. |
| **Topic clustering / sentiment topic charts** | Manager nice-to-have. Build only after SLA tracking is live and managers ask "why". |
| **Working hours auto-reply first-class UI** | Existing workflow node is sufficient. UI sugar after Phase 2 + 3 close. |
| **Number masking** | Solved by Phase 1B (PII Masking). |
| **2-way external CRM sync** (Salesforce/HubSpot/Zoho) | Our own CRM is shipped. External sync only matters for customers wanting to keep their existing CRM — small segment. Build via Zapier-style webhook hooks if a deal needs it. |

---

## 6. Competitive positioning vs DoubleTick (the closest peer)

### Where they're ahead
- Sensitive data masking (we close this in Phase 1B)
- AI agents trained on tenant data (we close this in Phase 3)
- SLA tracking + AI CX governance (we close partial in Phase 4; full governance is a Phase 7 item)
- WhatsApp catalog + order bot + payments-on-WA (we close + go further with khaata + delivery in Phase 5)
- 2-way CRM sync to Salesforce/HubSpot/Zoho (deferred — see above)
- ISO 27001 + SOC 2 certified (deferred)
- True native mobile apps (we close in Phase 6)

### Where we already lead
- **Multi-channel** (WA + IG + Telegram) — they're WA-only
- **Agency / white-label platform** — they have team RBAC; we have full multi-tenancy with revshare
- **Revshare credit-as-refund settlement** — unique architecture; nobody else has this
- **DPDPA-specific compliance** (Privacy Center, breach notifications, data residency) — first-class features
- **Lead ingest tokens** (third-party POST URL per tenant)
- **Webhook dead-letter + replay** (operational maturity)
- **WhatsApp Calling** integration
- **CTWA attribution** built into analytics

---

## 7. Operational notes

### Deploy targets
- **FE**: Vercel project `frequency-fe`. `stage` branch → `beta.getfrequency.app`. `main` branch → apex domain (TBD).
- **BE**: Fly.io app in `bom` region. GitHub Action `Deploy to Fly.io` triggers on push to `stage` or `main`.
- **DB**: Supabase project `yiicpndeggaedxobyopu`. Migrations applied via `supabase db push`. Current head: 092.

### Demo credentials
```
URL:      https://beta.getfrequency.app/auth
Email:    demo-agency@frequency.in
Password: Demo@2026!
```
Owns: Demo Growth Studio (agency), Demo Tenant Alpha + Beta (both linked as sub-accounts).

### Audit log conventions
- Structured error log token: `[ALERT_REVSHARE_PARTIAL_FAILURE]` — set up Slack/PagerDuty alerting on this string
- All super-admin mutations write to `super_admin_audit`
- DPDPA unmask events go to `pii_unmask_log` (will be added in Phase 1B)

---

## 8. Open questions for product/founders

1. **Phase 4 commerce pricing**: Bundle khaata + delivery into existing tenant plans, or charge as a separate "Commerce add-on"? My recommendation: separate ₹999-1499/mo add-on — different willingness-to-pay than messaging plan.
2. **Phase 6 mobile**: Build the delivery-boy mobile-web (Phase 4C) on the same Expo codebase, or treat it as a separate lightweight web app (since delivery boys turn over often and don't want app installs)? My recommendation: separate signed-URL web view (which is in the Phase 4C spec already).
3. **AI Agent costs**: Anthropic per-message inference cost adds up. Should we offer "AI agent" as free-tier (limited to 100 messages/day) and charge per-message above, or include in a higher tier flat? Need pricing analysis on average tenant conversation volume.
4. **Phase 2 timing**: The simple 3-step AI agent UX is opinionated. Want to A/B test this against a more traditional "training pipeline" UX with 10% of new tenants? Or commit to the simple version?
5. **ISO certification timing**: When in 2026 do we want to start the audit? Locks in 6 months of compliance prep + ~₹20L.

---

## Quick reference

| File | Purpose |
|---|---|
| `ROADMAP_CHECKLIST.md` | 1-page printable checklist for stand-ups |
| `ROADMAP.md` (this file) | Detailed reference for engineering + product |

Tasks tracked in the project task list:
- #2 AI Agent · #3 WA Commerce · #4 Quick Replies + Notes · #5 PII Masking · #6 SLA Tracking · #7 Native Mobile
