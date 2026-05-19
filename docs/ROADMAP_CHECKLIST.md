# Frequency · Product Roadmap Checklist

**Updated: 2026-05-19** &nbsp;·&nbsp; **Print-friendly, 1 page** &nbsp;·&nbsp; ✅ shipped · ☐ to build · — deferred

---

## Inbox & Conversations
- [x] Multi-channel inbox · WhatsApp · Instagram · Telegram
- [x] Voice-note transcripts
- [x] WhatsApp Calling integration
- [x] Conversation assignment + routing
- [ ] **P1** · Quick replies (workspace · team · personal tiers + variables)
- [ ] **P1** · Internal notes + `@mentions` (attach to convo / message / deal / contact)
- [ ] **P2** · PII / sensitive-data masking (Aadhaar, PAN, bank, email, phone, OTP)
- [ ] **P4** · SLA tracking + breach alerts (green/amber/red per conversation)
- [ ] **P6** · Native mobile screens (replace HostedScreen webview)

## Workflows & AI
- [x] No-code workflow engine
- [x] Curated workflow templates library
- [x] AI reply node (Anthropic backed)
- [x] Approval rules
- [ ] **P3** · AI Agent (3-step UI: Teach → Test → Turn on, with KB-RAG)

## Commerce & Payments
- [x] Razorpay native billing (subscriptions, refunds, GST invoices)
- [x] Shopify connector
- [x] CTWA attribution end-to-end
- [ ] **P5a** · WhatsApp catalog + order capture (voice / photo / Hindi text)
- [ ] **P5b** · Khaata ledger + monthly auto-settlement (Razorpay link)
- [ ] **P5c** · Delivery ops (route plan + delivery-boy app + customer pings)

## Analytics & Compliance
- [x] Tenant analytics page
- [x] Platform MRR sparkline + recent signups feed
- [x] DPDPA Privacy Center · breach notifications · data residency
- [x] Webhook dead-letter + replay (operational maturity)
- [ ] **P4** · Agent productivity dashboard (response · resolution times)
- [ ] **P4** · Per-team SLA reports
- &mdash; ISO 27001 / SOC 2 (defer to ₹2Cr ARR)
- &mdash; Custom dashboard/report builder (defer)

## Multi-Tenant / Agency
- [x] Agency console + sidebar + co-brand ("Name × Frequency")
- [x] Agency dashboard (tenants grid + revshare + plan utilization)
- [x] Agency Settings page (name · revshare · billing-default · archive)
- [x] Sub-account invite + accept + at-limit upgrade UX
- [x] Owner email/name on tenant cards
- [x] Tenant-context banner (when agency views managed tenant)
- [x] Revshare ledger + payouts page
- [x] **Razorpay credit-as-refund** (race-safe, audit-hardened, migration 092)
- [x] Agency signup page at `/agency-signup`
- [x] Platform console with Tenants | Agencies tabs (super-admin)
- [x] Super-admin can view any agency (with green banner)
- &mdash; Multi-number per tenant (defer)

## CRM & Contacts
- [x] Contacts + segments + bulk import
- [x] Lead tables + ingest tokens
- [x] Sales Pipeline (Kanban with stages)
- [x] Deal cards + activity timeline
- [ ] **P1** · Stage-aware quick-reply ranking (links to Pipeline deal stage)
- [ ] **P1** · Internal notes feed deal timeline (sales lead audit trail)

## Deploy & Ops
- [x] FE on Vercel → `beta.getfrequency.app` (stage branch auto-deploy)
- [x] BE on Fly.io `bom` region → `api.getfrequency.app` (GH Actions deploy)
- [x] Supabase project `yiicpndeggaedxobyopu` (092 applied)
- [x] Demo creds: `demo-agency@frequency.in` / `Demo@2026!`

---

## Phase Plan (~14 weeks)

| Phase | Weeks | Ships | Unlocks |
|---|---|---|---|
| **P1** | 1 | Quick Replies + Internal Notes | Agent retention · Pipeline collab |
| **P2** | 2 | PII Masking | BFSI / healthcare / fintech sales |
| **P3** | 3–4 | AI Agent (simple 3-step) | AI competitive parity |
| **P4** | 5 | SLA Tracking + Breach Alerts | Teams ≥ 3 agents |
| **P5** | 6–10 | WA Commerce (order + khaata + delivery) | Kirana / dairy / grocery segment |
| **P6** | 11–14 | Native Mobile Screens | Field-agent / field-sales adoption |

---

*Detailed spec: see `ROADMAP.md` in same folder.*
