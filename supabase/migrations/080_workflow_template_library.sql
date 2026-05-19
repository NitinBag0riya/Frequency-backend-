-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 080 — Workflow template library (P1 #13)
--
-- BRIEF: curated, public catalog of pre-authored workflow playbooks the
-- four India SMB verticals can clone with one tap:
--   • D2C abandoned cart        (Shopify + WhatsApp)
--   • EdTech course launch      (WhatsApp broadcast)
--   • Clinic appointment reminder (WhatsApp scheduled reminder)
--   • Real-estate site-visit pack (WhatsApp PDF + map + follow-up)
--
-- Schema model:
--   • workflow_templates       — read-only catalog. status='live' rows are
--                                visible to anon+authenticated (the catalog
--                                is intentionally public — tenants choose
--                                what to clone). INSERT/UPDATE/DELETE are
--                                revoked from anon+authenticated; super-
--                                admin manages out-of-band today and a
--                                /naruto/templates UI lands as a P2.
--   • workflow_template_clones — append-only audit. One row per clone
--                                with (template_id, tenant_id, workflow_id,
--                                cloned_by). SELECT scoped to the cloning
--                                tenant via the same (tenants.user_id =
--                                auth.uid()) OR (user_roles) pattern used
--                                everywhere else in this codebase.
--
-- On clone (POST /api/workflow-templates/:slug/clone) the BE:
--   1. Inserts a new public.workflows row in the caller's tenant with the
--      template's nodes_json copied verbatim into workflows.nodes, status
--      'draft' so the user iterates via the existing chat-driven builder.
--   2. Stamps workflow_template_clones with the new workflow_id.
--   3. Increments workflow_templates.usage_count.
--
-- The 4 templates are seeded at the bottom with ON CONFLICT (slug) DO NOTHING
-- so re-running this migration is safe.
--
-- Idempotent. No `||` inside COMMENT ON. RLS enabled on every new table.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Catalog table ─────────────────────────────────────────────────────────
create table if not exists public.workflow_templates (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,80}$'),
  vertical        text not null check (vertical in ('d2c','edtech','clinic','realestate','generic')),
  channel         text not null check (channel in ('whatsapp','telegram','instagram','multi')),
  title           text not null check (length(title) between 4 and 120),
  summary         text not null check (length(summary) between 8 and 600),
  hero_emoji      text not null default '⚡',
  -- nodes_json: workflow definition the user gets when they clone. Shape
  -- mirrors public.workflows.nodes (array of {id, type, config, next?}).
  -- The chat-driven builder lets the user tweak post-clone.
  nodes_json      jsonb not null,
  -- example_first_message: short preview of the first message a contact
  -- would receive. Shown on the template card so the user knows what
  -- they're cloning before committing.
  example_first_message text,
  -- prerequisites: connector keys (from the apps registry) the user must
  -- have connected before the template can fire. e.g. ['shopify','whatsapp']
  prerequisites    text[] not null default '{}',
  -- usage_count: bumped each time a tenant clones this template.
  usage_count      bigint not null default 0,
  status           text not null default 'live' check (status in ('live','draft','deprecated')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_wt_vertical_live on public.workflow_templates(vertical) where status = 'live';
create index if not exists idx_wt_status on public.workflow_templates(status);

alter table public.workflow_templates enable row level security;

-- SELECT: everyone (anon + authenticated) can browse live entries. The
-- catalog itself is non-sensitive curated content; tenants choose what to
-- clone, and cloning is gated separately on the BE route by requireAuth +
-- identifyTenant.
drop policy if exists "workflow_templates_read_all" on public.workflow_templates;
create policy "workflow_templates_read_all" on public.workflow_templates
  for select to anon, authenticated using (status = 'live');

-- INSERT/UPDATE/DELETE only via service-role. Super-admin manages the
-- catalog out-of-band today.
revoke insert, update, delete on public.workflow_templates from authenticated;
revoke insert, update, delete on public.workflow_templates from anon;

-- ── 2. Clone audit table ─────────────────────────────────────────────────────
create table if not exists public.workflow_template_clones (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references public.workflow_templates(id) on delete restrict,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  -- workflow_id points at the newly-created public.workflows row. NOT a FK
  -- because we never want a workflow delete to cascade-erase audit history.
  workflow_id     uuid not null,
  cloned_by       uuid references auth.users(id) on delete set null,
  cloned_at       timestamptz not null default now()
);
create index if not exists idx_wtc_tenant on public.workflow_template_clones(tenant_id);
create index if not exists idx_wtc_template on public.workflow_template_clones(template_id);

alter table public.workflow_template_clones enable row level security;

-- SELECT: a tenant member (owner OR user_roles) can read their own clones.
-- Same pattern used everywhere else in this codebase — see migration 078
-- (shopify_stores) for the canonical example. Brief specified a JWT-claim
-- variant; we use the project-wide join pattern instead so the policy
-- actually evaluates against the live auth context the rest of the app uses.
drop policy if exists "wtc_tenant_read" on public.workflow_template_clones;
create policy "wtc_tenant_read" on public.workflow_template_clones
  for select to authenticated
  using (
    exists (select 1 from public.tenants tn where tn.id = workflow_template_clones.tenant_id and tn.user_id = auth.uid())
    or exists (select 1 from public.user_roles r where r.tenant_id = workflow_template_clones.tenant_id and r.user_id = auth.uid())
  );

revoke insert, update, delete on public.workflow_template_clones from authenticated;
revoke insert, update, delete on public.workflow_template_clones from anon;

-- ── 3. Seed 4 launch templates ───────────────────────────────────────────────
-- Each nodes_json mirrors public.workflows.nodes — array of
-- { id, type, config, next? } objects the executor already understands. We
-- keep them minimal but valid: one trigger + one action, with placeholders
-- the user customizes via the chat builder post-clone.

insert into public.workflow_templates (slug, vertical, channel, title, summary, hero_emoji, nodes_json, example_first_message, prerequisites)
values
  (
    'd2c-abandoned-cart',
    'd2c',
    'whatsapp',
    'Recover abandoned Shopify carts',
    'Catch shoppers who add to cart but don''t pay. Sends a WhatsApp nudge with the cart link 30 minutes after abandonment.',
    '🛒',
    '[
      {
        "id": "trigger",
        "type": "shopify_abandoned_cart",
        "config": {
          "delay_minutes": 30
        },
        "next": "send_recovery"
      },
      {
        "id": "send_recovery",
        "type": "send_template",
        "config": {
          "template_name": "cart_recovery",
          "language": "en",
          "variables": ["{{first_name}}", "{{cart_url}}"]
        },
        "next": "end"
      },
      {
        "id": "end",
        "type": "end_flow",
        "config": {}
      }
    ]'::jsonb,
    'Hi {{first_name}}, you left items in your cart! Complete checkout here: {{cart_url}}',
    array['shopify','whatsapp']
  ),
  (
    'edtech-course-launch',
    'edtech',
    'whatsapp',
    'Announce a course launch on WhatsApp',
    'Broadcast a course-launch announcement to a saved segment with seat count and CTA. Schedule it for launch day; the workflow handles delivery + opt-outs.',
    '🎓',
    '[
      {
        "id": "trigger",
        "type": "trigger_schedule",
        "config": {
          "cron": "0 10 * * *",
          "note": "User picks the exact launch date+time in the chat builder."
        },
        "next": "send_launch"
      },
      {
        "id": "send_launch",
        "type": "send_template",
        "config": {
          "template_name": "course_launch",
          "language": "en",
          "variables": ["{{first_name}}", "{{course_name}}", "{{enroll_url}}"],
          "audience": "segment:interested_in_courses"
        },
        "next": "end"
      },
      {
        "id": "end",
        "type": "end_flow",
        "config": {}
      }
    ]'::jsonb,
    'Hi {{first_name}}, our new {{course_name}} batch opens today. Reserve your seat: {{enroll_url}}',
    array['whatsapp']
  ),
  (
    'clinic-appointment-reminder',
    'clinic',
    'whatsapp',
    'Remind patients 24h before their appointment',
    'Auto-reminds patients via WhatsApp 24 hours before their booking. Uses the contact''s next_appointment_at attribute as the schedule anchor.',
    '🩺',
    '[
      {
        "id": "trigger",
        "type": "trigger_contact_attribute_time",
        "config": {
          "attribute": "next_appointment_at",
          "offset_hours": -24
        },
        "next": "send_reminder"
      },
      {
        "id": "send_reminder",
        "type": "send_template",
        "config": {
          "template_name": "appointment_reminder",
          "language": "en",
          "variables": ["{{first_name}}", "{{next_appointment_at}}", "{{doctor_name}}"]
        },
        "next": "end"
      },
      {
        "id": "end",
        "type": "end_flow",
        "config": {}
      }
    ]'::jsonb,
    'Hi {{first_name}}, this is a reminder for your appointment with {{doctor_name}} on {{next_appointment_at}}. Reply STOP to cancel.',
    array['whatsapp']
  ),
  (
    'realestate-site-visit-pack',
    'realestate',
    'whatsapp',
    'Send a site-visit pack on WhatsApp',
    'When a contact is tagged site_visit_scheduled, sends the property brochure (PDF) + Google Maps location, then follows up 24 hours after the visit for feedback.',
    '🏠',
    '[
      {
        "id": "trigger",
        "type": "trigger_contact_tagged",
        "config": {
          "tag": "site_visit_scheduled"
        },
        "next": "send_brochure"
      },
      {
        "id": "send_brochure",
        "type": "send_media",
        "config": {
          "media_type": "document",
          "url": "{{property.brochure_pdf}}",
          "caption": "Hi {{first_name}}, here is the brochure for {{property.name}}."
        },
        "next": "send_location"
      },
      {
        "id": "send_location",
        "type": "send_template",
        "config": {
          "template_name": "site_visit_location",
          "language": "en",
          "variables": ["{{property.name}}", "{{property.maps_url}}", "{{visit_time}}"]
        },
        "next": "wait_post_visit"
      },
      {
        "id": "wait_post_visit",
        "type": "wait_delay",
        "config": {
          "delay_hours": 24
        },
        "next": "send_followup"
      },
      {
        "id": "send_followup",
        "type": "send_template",
        "config": {
          "template_name": "site_visit_followup",
          "language": "en",
          "variables": ["{{first_name}}", "{{property.name}}"]
        },
        "next": "end"
      },
      {
        "id": "end",
        "type": "end_flow",
        "config": {}
      }
    ]'::jsonb,
    'Hi {{first_name}}, here is the brochure and location for {{property.name}}. See you at {{visit_time}}.',
    array['whatsapp']
  )
on conflict (slug) do nothing;
