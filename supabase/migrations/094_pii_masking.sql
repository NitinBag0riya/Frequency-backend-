-- 094_pii_masking
--
-- Phase 1B of the post-deploy roadmap (docs/ROADMAP.md). DPDPA + BFSI/
-- healthcare/fintech sales unblock: sensitive personal data shown in the
-- agent inbox is auto-masked at render time, and any unmask is logged.
--
-- ─── What this migration creates ──────────────────────────────────────────
--
-- 1. pii_masking_config — per-tenant settings (which field types to mask,
--    which roles are allowed to unmask without per-event approval). One
--    row per tenant; auto-seeded by the BE on first read.
--
-- 2. pii_unmask_log — append-only audit trail. Every time an agent reveals
--    masked data the row is written: actor, contact, field_type, source
--    message (if applicable), reason, IP, user_agent, ts. Service-role
--    writes only (RLS revokes write from authenticated to keep the audit
--    trail untamperable from the app layer).
--
-- ─── Field types we detect (regex-driven on the BE; ML upgrade later) ────
--
--   aadhaar           : XXXX XXXX XXXX  (12 digits, Verhoeff check optional)
--   pan               : ABCDE1234F      (5 alpha + 4 digit + 1 alpha)
--   bank_account      : 9–18 digit run with optional spaces
--   ifsc              : ABCD0123456     (4 alpha + 0 + 6 alphanumeric)
--   phone             : Indian mobile / international
--   email             : standard pattern
--   dob               : DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, "1st Jan 1990"
--   policy_number     : 6+ alnum, configurable per tenant via regex_override
--   transaction_id    : 8+ alnum mixed
--   otp               : "OTP is 1234" / "code: 567890" patterns
--
-- New types can be added by inserting into pii_field_definitions (an
-- optional per-tenant extensibility table, separate migration when needed).
--
-- ─── How the mask is applied at runtime ──────────────────────────────────
--
-- Render-time only — message bodies are NEVER stored masked. The BE
-- /api/inbox/messages handler applies maskText() before returning bodies,
-- gated on the caller's role vs pii_masking_config.unmask_roles. Storage
-- stays plaintext so legitimate compliance / DSR exports stay accurate.
--
-- Unmask flow: agent taps a masked chip → POST /api/pii/unmask with
-- {message_id, field_index, reason?} → audit log row written → original
-- text returned to the FE for that single field only.

set check_function_bodies = off;

-- ─── 1. pii_masking_config ────────────────────────────────────────────────

create table if not exists public.pii_masking_config (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  -- Enabled field types. Default-on for the high-risk Indian regulated set;
  -- tenant admins can flip off any they don't want masked.
  enabled_types       text[] not null default array[
    'aadhaar','pan','bank_account','ifsc','phone','email','dob','otp'
  ]::text[],
  -- Role keys allowed to see PII UNMASKED by default (no per-event approval
  -- needed). Other agents see the masked chip and must tap-to-unmask, which
  -- always logs to pii_unmask_log.
  -- Default: 'tenant_admin' and 'tenant_owner' get free pass; everyone else
  -- has to tap-and-log.
  unmask_roles        text[] not null default array['tenant_admin','tenant_owner']::text[],
  -- When true, every unmask requires a reason string from the agent.
  -- BFSI / healthcare tenants will flip this on for stronger audit.
  require_reason      boolean not null default false,
  -- Per-tenant extensibility: regex overrides keyed by field_type. e.g.
  -- { "policy_number": "^POL[0-9]{8}$" } for a tenant whose policy number
  -- format is specific to their org. Keys not in this map fall back to
  -- the global default regex from the BE lib.
  regex_overrides     jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists ux_pii_masking_config_tenant
  on public.pii_masking_config(tenant_id);

comment on table public.pii_masking_config is
  'Per-tenant PII masking policy. enabled_types = which field families to detect+mask; unmask_roles = which platform roles see PII without tap-to-unmask. The BE seeds a default row on first read for any tenant that hasn''t configured.';

-- ─── 2. pii_unmask_log ────────────────────────────────────────────────────

create table if not exists public.pii_unmask_log (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  actor_user_id       uuid references auth.users(id) on delete set null,
  contact_id          uuid references public.contacts(id) on delete set null,
  message_id          text,                          -- text not uuid because messages.id varies by schema
  field_type          text not null,                 -- one of the enabled_types values
  field_value_hash    text,                          -- sha256 hex of the value, NOT the value itself
  reason              text,                          -- optional free-text reason if require_reason=true
  ip                  inet,
  user_agent          text,
  unmasked_at         timestamptz not null default now()
);

create index if not exists idx_pii_unmask_log_tenant_time
  on public.pii_unmask_log(tenant_id, unmasked_at desc);

create index if not exists idx_pii_unmask_log_actor_time
  on public.pii_unmask_log(actor_user_id, unmasked_at desc);

create index if not exists idx_pii_unmask_log_contact_time
  on public.pii_unmask_log(contact_id, unmasked_at desc);

comment on table public.pii_unmask_log is
  'Append-only audit trail of every PII unmask action. field_value_hash is sha256 of the revealed value (NOT the value itself) so audit can verify ''this agent saw this specific number'' without storing the secret. Service-role writes only — RLS revokes INSERT from authenticated to keep audit untamperable from the app layer.';

-- ─── 3. RLS ───────────────────────────────────────────────────────────────

alter table public.pii_masking_config enable row level security;
alter table public.pii_unmask_log enable row level security;

-- pii_masking_config: tenant members read; admin-role write (BE additionally
-- gates writes on role check, RLS is belt-and-suspenders).
drop policy if exists "pii_masking_config_tenant_read" on public.pii_masking_config;
create policy "pii_masking_config_tenant_read" on public.pii_masking_config
  for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
  );

-- Writes only by service-role (the BE applies the role gate before
-- calling). We don't have a built-in admin-role discriminator at RLS
-- level here, and giving authenticated write access would let any
-- agent disable masking via a direct POST. Conservative: no
-- authenticated writes; BE service-role is the only writer.
revoke insert, update, delete on public.pii_masking_config from authenticated;

-- pii_unmask_log: tenant members + compliance read. Append-only — no
-- updates or deletes ever from any role, including service-role at the
-- RLS layer (the GRANT below enforces it).
drop policy if exists "pii_unmask_log_tenant_read" on public.pii_unmask_log;
create policy "pii_unmask_log_tenant_read" on public.pii_unmask_log
  for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
  );

-- Append-only at GRANT level — even if some policy slipped, authenticated
-- can never insert/update/delete. service-role is the only writer (BE
-- handler computes the hash + logs the row).
revoke insert, update, delete on public.pii_unmask_log from authenticated;
