-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 068 — Template reclassification safety net + consent fields
--
-- Adds three additive columns + supporting machinery for the in-app wedge
-- surface (Batch B, FE half landed in commit c1cd721; this is the BE schema
-- the new endpoints + worker need):
--
--   • wa_templates.previous_category   — set by the template-sync worker
--                                        when Meta flips a template's
--                                        category (e.g. utility → marketing,
--                                        the ~7× price + delivery-rate cliff).
--                                        Lets the FE show "was Utility →
--                                        now Marketing" diff badge.
--   • wa_templates.category_changed_at — when the flip was observed. Drives
--                                        the "auto-paused N minutes ago"
--                                        label on the CampaignsPage banner.
--   • campaigns.pause_reason           — discriminates user-paused (manual)
--                                        from system-paused (template
--                                        reclassification). Values:
--                                          'template_reclassified'
--                                          'user'
--                                          'system_billing'
--                                          (NULL = active or unknown)
--
--   • contacts.consent_captured_at     — when DPDPA consent was recorded
--   • contacts.consent_source          — free-text source label (e.g.
--                                        'manual', 'inbox_optin', 'webhook')
--
-- All additions are IF NOT EXISTS / additive — safe to re-apply. RLS is
-- unchanged: the existing per-tenant policies on each table continue to
-- gate access to the new columns.
--
-- The auto-pause LOGIC lives in src/workers/template-sync.ts (extended in
-- the same batch). The resume action is at POST /api/campaigns/:id/resume
-- in src/routes/wedge-surface.ts.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── wa_templates: track Meta category flips ─────────────────────────────────
alter table public.wa_templates
  add column if not exists previous_category   text,
  add column if not exists category_changed_at timestamptz;

comment on column public.wa_templates.previous_category is
  'Previous Meta-assigned category before the most recent reclassification. '
  'Set by template-sync.ts when it detects a category delta during the 15-min poll. '
  'Null = no reclassification has ever been observed.';
comment on column public.wa_templates.category_changed_at is
  'When the most recent category reclassification was observed by template-sync. '
  'Pairs with previous_category to drive the "auto-paused" banner and the '
  '"X minutes ago" label on the campaigns page.';

-- Partial index — queries that look at "templates flipped in the last N days"
-- (e.g. the admin "what changed this week?" report) hit the indexed subset.
create index if not exists wat_category_changed_at
  on public.wa_templates(tenant_id, category_changed_at desc)
  where category_changed_at is not null;

-- ── campaigns: pause_reason discriminator ───────────────────────────────────
-- TEXT (not enum) on purpose — we want to add new reasons without a schema
-- change later (e.g. 'rate_limit', 'meta_quality_low'). The application
-- layer validates the set of legal values per-write.
alter table public.campaigns
  add column if not exists pause_reason text;

comment on column public.campaigns.pause_reason is
  'When campaigns.status = paused, why. Values include: '
  'template_reclassified (Meta flipped a template category), '
  'user (manual pause from the campaigns page), '
  'system_billing (over-quota or payment failed). '
  'NULL when status != paused.';

-- Partial index — the campaigns page banner query is "show me every campaign
-- in this tenant whose pause_reason = template_reclassified". Small index.
create index if not exists campaigns_pause_reason_idx
  on public.campaigns(tenant_id, pause_reason)
  where pause_reason is not null;

-- ── contacts: DPDPA consent capture ─────────────────────────────────────────
-- The tenant_audit table is the EVIDENTIARY record (it's append-only with
-- SECURITY DEFINER + REVOKE on UPDATE/DELETE). These two columns are the
-- DENORMALIZED hot-path read so the contacts list can show a consent badge
-- without joining audit on every render.
alter table public.contacts
  add column if not exists consent_captured_at timestamptz,
  add column if not exists consent_source      text;

comment on column public.contacts.consent_captured_at is
  'When DPDPA-compliant consent was last recorded for this contact. '
  'Hot-path mirror of the tenant_audit row written by '
  'POST /api/contacts/:id/consent (the audit row is the legal record).';
comment on column public.contacts.consent_source is
  'How the consent was captured: e.g. manual, inbox_optin, webhook, csv_import. '
  'Free-text — application validates the per-feature set.';

-- Index for "how many of my contacts have valid consent?" reports.
create index if not exists contacts_consent_captured_idx
  on public.contacts(tenant_id, consent_captured_at desc)
  where consent_captured_at is not null;

-- ── notification event type: campaign.auto_paused ───────────────────────────
-- Fired by src/workers/template-sync.ts when Meta reclassifies a template
-- and one or more campaigns get auto-paused as a result. Default to
-- in_app + email so the admin sees it before the next send cycle even
-- if they're not currently in the dashboard.
insert into public.notification_event_types
  (key, category, title_template, body_template, default_channels, severity, description)
values
  ('campaign.auto_paused', 'campaign',
   'Campaign auto-paused: template reclassified',
   'Meta moved "{{template_name}}" from {{from_category}} → {{to_category}}. '
   'We paused {{affected_count}} campaign(s) using it ({{affected_names_preview}}). '
   'Review and resume from /campaigns.',
   array['in_app','email']::text[],
   'warning',
   'A WhatsApp template was reclassified by Meta and dependent campaigns were auto-paused for review.')
on conflict (key) do update set
  category         = excluded.category,
  title_template   = excluded.title_template,
  body_template    = excluded.body_template,
  default_channels = excluded.default_channels,
  severity         = excluded.severity,
  description      = excluded.description;
