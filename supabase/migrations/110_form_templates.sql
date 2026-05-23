-- ────────────────────────────────────────────────────────────────────────
-- Migration 110 — Form templates marketplace (Block E)
-- ────────────────────────────────────────────────────────────────────────
-- A curated + community library of forms a new tenant can fork into
-- their workspace with one click.
--
-- Curated templates (is_curated=true) are seeded + maintained by
-- Frequency staff; only super-admins can write them.
-- Tenant-published templates (is_curated=false) are owned by the
-- publishing tenant; readable by everyone authenticated.
-- ────────────────────────────────────────────────────────────────────────

create table if not exists public.form_templates (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  title               text not null,
  description         text,
  category            text not null
                      check (category in (
                        'lead_capture','event_rsvp','booking','payment','signed','survey','other'
                      )),
  -- The schema_json shape mirrors form_pages.schema_json (page-schema.ts).
  schema_json         jsonb not null,
  -- Optional preset post-save action shape (template suggests, user can
  -- override after fork).
  default_action_json jsonb default '{"kind":"none"}'::jsonb,
  screenshot_url      text,
  is_curated          boolean not null default false,
  -- Tenant who published this template; null for curated.
  author_tenant_id    uuid references public.tenants(id) on delete set null,
  fork_count          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_form_templates_curated_category
  on public.form_templates (is_curated, category);
create index if not exists idx_form_templates_author
  on public.form_templates (author_tenant_id) where author_tenant_id is not null;

alter table public.form_templates enable row level security;
-- Read: anyone authenticated. Both curated + tenant-published.
create policy form_templates_read_all_authed on public.form_templates
  for select using (auth.uid() is not null);
-- Write: tenants can publish their own (insert + update + delete);
-- service-role writes curated.
create policy form_templates_write_own on public.form_templates
  for all using (
    auth.uid() is not null and (
      author_tenant_id is null
      or exists (
        select 1 from public.user_role_assignments
        where user_id = auth.uid() and tenant_id = form_templates.author_tenant_id
          and disabled_at is null
      )
    )
  );

-- Updated-at trigger reuses the helper from migration 105.
drop trigger if exists trg_form_templates_updated_at on public.form_templates;
create trigger trg_form_templates_updated_at before update on public.form_templates
  for each row execute function public.set_updated_at();

-- ── Seed 4 curated templates ────────────────────────────────────────────
-- Small, opinionated set; more can land via super-admin UI later.
insert into public.form_templates (slug, title, description, category, schema_json, is_curated, screenshot_url) values
  (
    'realty-lead-capture',
    'Realty lead capture',
    'Capture intent + budget for property visits. Auto-WhatsApp confirmation.',
    'lead_capture',
    '{"version":1,"widgets":[
       {"id":"h1","kind":"header","show_contact_strip":true},
       {"id":"f1","kind":"form","submit_label":"Request visit","success_message":"Thanks — our team will WhatsApp you within 24h.","fields":[
         {"id":"name","kind":"short_text","label":"Your name","required":true},
         {"id":"phone","kind":"phone","label":"WhatsApp number","required":true},
         {"id":"interest","kind":"select","label":"Interested in","options":["1 BHK","2 BHK","3 BHK","Plot","Commercial"]},
         {"id":"budget","kind":"select","label":"Budget","options":["Below ₹50L","₹50L-1Cr","₹1-2Cr","Above ₹2Cr"]}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'event-rsvp',
    'Event RSVP',
    'Collect attendance + dietary preferences. WhatsApp the calendar invite.',
    'event_rsvp',
    '{"version":1,"widgets":[
       {"id":"h1","kind":"header","show_contact_strip":true},
       {"id":"f1","kind":"form","submit_label":"Confirm attendance","success_message":"Thanks for RSVPing.","fields":[
         {"id":"name","kind":"short_text","label":"Your name","required":true},
         {"id":"email","kind":"email","label":"Email","required":true},
         {"id":"guests","kind":"number","label":"Number of guests","min":1,"max":10,"step":1},
         {"id":"diet","kind":"radio","label":"Dietary preference","options":["Vegetarian","Non-vegetarian","Jain","Vegan"]}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'service-booking',
    'Service booking',
    'Date + slot + contact. Sends to your CRM Table.',
    'booking',
    '{"version":1,"widgets":[
       {"id":"h1","kind":"header","show_contact_strip":true},
       {"id":"f1","kind":"form","submit_label":"Book now","success_message":"Booking received.","fields":[
         {"id":"name","kind":"short_text","label":"Your name","required":true},
         {"id":"phone","kind":"phone","label":"Phone","required":true},
         {"id":"service","kind":"select","label":"Service","options":["Consultation","Site visit","Quote","Other"]},
         {"id":"date","kind":"date","label":"Preferred date","required":true},
         {"id":"notes","kind":"long_text","label":"Additional notes"}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'nps-survey',
    'NPS feedback',
    'Quick rating + open feedback. One-question funnel.',
    'survey',
    '{"version":1,"widgets":[
       {"id":"h1","kind":"header","show_contact_strip":false},
       {"id":"sec","kind":"section","heading":"How did we do?","body":"30 seconds. Helps us a lot."},
       {"id":"f1","kind":"form","submit_label":"Submit feedback","success_message":"Thank you!","fields":[
         {"id":"score","kind":"rating","label":"How likely are you to recommend us?","rating_max":10,"required":true},
         {"id":"feedback","kind":"long_text","label":"What stood out (or could be better)?"}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  )
on conflict (slug) do nothing;
