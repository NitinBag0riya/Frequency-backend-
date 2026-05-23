-- ────────────────────────────────────────────────────────────────────────
-- 115_site_page_templates.sql
--
-- Page-level template marketplace for Sites. Mirrors the form_templates
-- table (migration 110) but for the Site-page schema. A tenant building
-- a Site clicks "+ New page" → picks a template → forks into their Site
-- as a new site_pages row, pre-populated with widgets.
--
-- Categories cover the common page types in an Indian SMB site:
--   landing      — hero + form lead capture
--   about        — company story / mission
--   pricing      — tier comparison table
--   contact      — contact form + address block
--   faq          — common questions
--   coming_soon  — email capture for pre-launch
--   thank_you    — post-conversion confirmation
--   features     — product capabilities grid
--   testimonials — customer love wall
--   other        — uncategorised
--
-- Differs from form_templates:
--   • No payment / signed / survey categories — those belong to forms.
--   • No default_action_json — page templates don't impose a post-submit
--     action; the user wires that per-form-widget inside the builder.
--   • Schema_json uses the page widget union (header / hero / section /
--     form / image / video / cta / divider / payment / footer / site_nav)
--     so fork → new site_pages.schema_json directly.
--
-- Seeded with 8 curated templates. Tenant-published templates can land
-- later via POST /api/sites/.../publish-as-template (Block E equivalent).
-- ────────────────────────────────────────────────────────────────────────

create table if not exists public.site_page_templates (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique,
  title             text not null,
  description       text,
  category          text not null
                    check (category in (
                      'landing','about','pricing','contact','faq',
                      'coming_soon','thank_you','features','testimonials','other'
                    )),
  schema_json       jsonb not null,
  is_curated        boolean not null default false,
  author_tenant_id  uuid references public.tenants(id) on delete set null,
  screenshot_url    text,
  fork_count        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_site_page_templates_curated_category
  on public.site_page_templates (is_curated, category);
create index if not exists idx_site_page_templates_fork_count
  on public.site_page_templates (fork_count desc);

alter table public.site_page_templates enable row level security;

-- Anyone authed can read. Service role only on writes (we POST as service
-- role from the BE; FE never inserts directly).
create policy site_page_templates_read on public.site_page_templates
  for select to authenticated using (true);

drop trigger if exists trg_site_page_templates_updated_at on public.site_page_templates;
create trigger trg_site_page_templates_updated_at before update on public.site_page_templates
  for each row execute function public.set_updated_at();

-- RPC for atomic fork_count increment — same pattern as form_templates.
create or replace function public.increment_site_page_template_fork_count(p_template_id uuid)
returns void language sql security definer as $$
  update public.site_page_templates set fork_count = fork_count + 1 where id = p_template_id;
$$;
grant execute on function public.increment_site_page_template_fork_count(uuid) to authenticated;

-- ── Seeds ───────────────────────────────────────────────────────────────
insert into public.site_page_templates
  (slug, title, description, category, schema_json, is_curated)
values
  ('landing-saas-hero', 'SaaS landing — Hero + lead form',
   'Big headline, sub-line, primary CTA, and an inline lead form. Drop in your value prop and ship.',
   'landing',
   '{"version":1,"page_width":"full","widgets":[
     {"id":"l1-header","kind":"header","show_contact_strip":false},
     {"id":"l1-hero","kind":"hero","headline":"The fastest way to do X.","subheadline":"Built for Indian businesses that want results, not bloat.","cta_label":"Start free","cta_url":"#form","background_image_url":""},
     {"id":"l1-section","kind":"section","heading":"Why teams choose us","body":"Three reasons our customers stay:\n• 10× faster setup\n• Built for ₹999/month budgets\n• Local-first integrations"},
     {"id":"l1-form","kind":"form","submit_label":"Get a demo","success_message":"Thanks! We will reach out within 24 hours.","fields":[
       {"id":"f1","kind":"short_text","label":"Full name","required":true,"placeholder":"Your name","width":"half"},
       {"id":"f2","kind":"email","label":"Work email","required":true,"placeholder":"you@company.com","width":"half"},
       {"id":"f3","kind":"phone","label":"Phone","required":true,"placeholder":"+91 98765 43210"},
       {"id":"f4","kind":"long_text","label":"What problem are you trying to solve?","required":false}
     ]},
     {"id":"l1-footer","kind":"footer","show_brand_block":true,"show_powered_by":true}
   ]}'::jsonb,
   true),

  ('about-company-story', 'About — Company story',
   'Mission, values, team. A simple page to tell visitors who you are without overthinking the layout.',
   'about',
   '{"version":1,"page_width":"centered","widgets":[
     {"id":"a1-header","kind":"header","show_contact_strip":true},
     {"id":"a1-hero","kind":"hero","headline":"We exist to make ___ easier.","subheadline":"And we have been quietly doing it since 2024."},
     {"id":"a1-section1","kind":"section","heading":"Our story","body":"A few sentences about how the company started — the gap you noticed, who you built it for, why it matters."},
     {"id":"a1-section2","kind":"section","heading":"What we believe","body":"Three principles that guide every product decision:\n\n1. Simplicity beats features.\n2. Local language matters.\n3. Customer support is a product, not a cost center."},
     {"id":"a1-cta","kind":"cta","label":"Get in touch","url":"#contact","variant":"primary"},
     {"id":"a1-footer","kind":"footer","show_brand_block":true,"show_powered_by":true}
   ]}'::jsonb,
   true),

  ('pricing-three-tier', 'Pricing — Three tiers',
   'Free / Starter / Pro layout in three section blocks. Edit the copy per tier; CTAs link to your sign-up form.',
   'pricing',
   '{"version":1,"page_width":"full","widgets":[
     {"id":"p1-header","kind":"header","show_contact_strip":false},
     {"id":"p1-hero","kind":"hero","headline":"Plans for every team size.","subheadline":"All plans include unlimited form submissions and our entire widget library."},
     {"id":"p1-divider","kind":"divider"},
     {"id":"p1-free","kind":"section","heading":"Free — ₹0/month","body":"For solo founders kicking the tires.\n• 1 site / 3 pages\n• 2,000 submissions per month\n• Email support"},
     {"id":"p1-starter","kind":"section","heading":"Starter — ₹999/month","body":"For growing teams that need more headroom.\n• 50 sites / unlimited pages\n• 20,000 submissions per month\n• Priority support + integrations"},
     {"id":"p1-pro","kind":"section","heading":"Pro — ₹2,499/month","body":"For agencies and high-traffic businesses.\n• Unlimited everything\n• Custom domains\n• Dedicated success manager"},
     {"id":"p1-cta","kind":"cta","label":"Start free trial","url":"#","variant":"primary"},
     {"id":"p1-footer","kind":"footer","show_brand_block":true,"show_powered_by":true}
   ]}'::jsonb,
   true),

  ('contact-form-address', 'Contact — Form + address',
   'Quick contact form, a "where to find us" block, and a footer with phone + email. Lands inquiries straight into a Table.',
   'contact',
   '{"version":1,"page_width":"centered","widgets":[
     {"id":"c1-header","kind":"header","show_contact_strip":true},
     {"id":"c1-section","kind":"section","heading":"Get in touch","body":"Drop us a line and we will get back within one business day."},
     {"id":"c1-form","kind":"form","submit_label":"Send message","success_message":"Got it! We will reply to your inbox soon.","fields":[
       {"id":"f1","kind":"short_text","label":"Name","required":true,"width":"half"},
       {"id":"f2","kind":"email","label":"Email","required":true,"width":"half"},
       {"id":"f3","kind":"select","label":"What is this about?","required":true,"options":["Sales inquiry","Support","Partnership","Other"]},
       {"id":"f4","kind":"long_text","label":"Message","required":true,"placeholder":"Tell us what you need…"}
     ]},
     {"id":"c1-section2","kind":"section","heading":"Visit us","body":"123, MG Road, Bangalore 560001\nMonday to Friday · 10am to 7pm IST"},
     {"id":"c1-footer","kind":"footer","show_brand_block":true,"show_powered_by":true}
   ]}'::jsonb,
   true),

  ('faq-common-questions', 'FAQ — Common questions',
   'A clean Q&A list using section blocks. Edit each block to match your actual customer questions.',
   'faq',
   '{"version":1,"page_width":"centered","widgets":[
     {"id":"q1-header","kind":"header","show_contact_strip":false},
     {"id":"q1-hero","kind":"hero","headline":"Frequently asked questions","subheadline":"Cannot find what you are looking for? Get in touch."},
     {"id":"q1-q1","kind":"section","heading":"How long does setup take?","body":"Most teams are live within an hour. The builder is drag-and-drop and our templates ship with sensible defaults."},
     {"id":"q1-q2","kind":"section","heading":"Do you support custom domains?","body":"Custom domain support is on the way. For now your site lives at our subdomain and we will email you when DNS provisioning ships."},
     {"id":"q1-q3","kind":"section","heading":"Can I export my data?","body":"Yes — every form submission can be exported as CSV from the Submissions tab. Tables export via the same surface."},
     {"id":"q1-q4","kind":"section","heading":"How do I cancel?","body":"From Settings → Billing. Cancel anytime; you keep access through the end of the current billing cycle."},
     {"id":"q1-cta","kind":"cta","label":"Contact support","url":"#","variant":"secondary"},
     {"id":"q1-footer","kind":"footer","show_brand_block":true,"show_powered_by":true}
   ]}'::jsonb,
   true),

  ('coming-soon-email-capture', 'Coming soon — Email capture',
   'Pre-launch landing page. Big "coming soon" headline + email signup. Use while you build the real thing.',
   'coming_soon',
   '{"version":1,"page_width":"centered","widgets":[
     {"id":"cs1-hero","kind":"hero","headline":"Something good is coming.","subheadline":"We are putting the finishing touches on a tool that will change how Indian SMBs handle ___. Sign up to hear first."},
     {"id":"cs1-form","kind":"form","submit_label":"Notify me","success_message":"You are on the list. We will be in touch when we launch.","fields":[
       {"id":"f1","kind":"email","label":"Email","required":true,"placeholder":"you@company.com"}
     ]},
     {"id":"cs1-section","kind":"section","heading":"What to expect","body":"Launch in early 2026. Limited beta seats; the list above gets first dibs."}
   ]}'::jsonb,
   true),

  ('thank-you-confirmation', 'Thank you — Post-submit',
   'Where to redirect after a form submission. Confirms receipt, sets expectations, and offers a next step.',
   'thank_you',
   '{"version":1,"page_width":"centered","widgets":[
     {"id":"ty1-header","kind":"header","show_contact_strip":false},
     {"id":"ty1-hero","kind":"hero","headline":"Thanks — we have got your details.","subheadline":"Our team will reach out within one business day."},
     {"id":"ty1-section","kind":"section","heading":"While you wait","body":"Have a look at our case studies to see how other Indian SMBs are using Frequency to convert more leads."},
     {"id":"ty1-cta","kind":"cta","label":"Read case studies","url":"#","variant":"primary"},
     {"id":"ty1-footer","kind":"footer","show_brand_block":true,"show_powered_by":true}
   ]}'::jsonb,
   true),

  ('testimonials-customer-love', 'Testimonials — Customer love',
   'Three customer quotes in a vertical stack. Easy to extend with more sections as testimonials roll in.',
   'testimonials',
   '{"version":1,"page_width":"centered","widgets":[
     {"id":"t1-header","kind":"header","show_contact_strip":false},
     {"id":"t1-hero","kind":"hero","headline":"Customers say it best.","subheadline":"What real Indian SMBs are saying about Frequency."},
     {"id":"t1-q1","kind":"section","heading":"\"Cut our setup time from 3 days to 30 minutes.\"","body":"— Priya Sharma, Founder, GreenLeaf Realty\n\nWe replaced four separate tools with Frequency and now run our entire lead pipeline through one screen. Worth it for the WhatsApp automation alone."},
     {"id":"t1-q2","kind":"section","heading":"\"Finally a builder priced for Indian SMBs.\"","body":"— Arjun Patel, Co-founder, Patel Coaching\n\nThe ₹999 plan covers everything we need. We went from spending ₹15,000/month on tools to one bill, and added more features in the process."},
     {"id":"t1-q3","kind":"section","heading":"\"Their support actually replies.\"","body":"— Anika Reddy, Marketing Head, BlueWave Travels\n\nWe had a custom integration question on a Sunday and got a real answer within an hour. That is the difference between a tool and a partner."},
     {"id":"t1-cta","kind":"cta","label":"See more case studies","url":"#","variant":"secondary"},
     {"id":"t1-footer","kind":"footer","show_brand_block":true,"show_powered_by":true}
   ]}'::jsonb,
   true)

on conflict (slug) do update set
  title       = excluded.title,
  description = excluded.description,
  category    = excluded.category,
  schema_json = excluded.schema_json,
  is_curated  = excluded.is_curated,
  updated_at  = now();

comment on table public.site_page_templates is
  'Curated + tenant-published templates for Site pages. Fork via POST /api/sites/:siteId/pages/from-template/:templateId.';
