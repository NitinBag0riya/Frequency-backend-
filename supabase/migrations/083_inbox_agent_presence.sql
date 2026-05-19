-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 083 — Inbox agent presence audit (P1 #16)
--
-- BRIEF: Real-time agent-collision detection in the inbox. When two agents
-- have the same conversation open and one starts typing/replying, the other
-- sees a live banner / pill so they don't duplicate work.
--
-- The LIVE state (who has the thread open right now, who's typing, who just
-- clicked Send) is broadcast through Supabase Realtime presence + broadcast
-- channels keyed by conversation. That's ephemeral by design — when an agent
-- closes the tab, the channel emits `leave` and other viewers immediately
-- see them disappear. We do NOT persist live presence in Postgres.
--
-- This migration adds the AUDIT side only: an append-only per-event log so
-- post-incident we can answer "who handled WhatsApp conversation X on
-- Tuesday afternoon" without scraping Realtime channel logs. It's also the
-- data that feeds analytics like "which agents are most active in inbox?"
-- and "how often do two agents land on the same thread in the same minute?"
-- (a proxy for collision frequency — drives staffing decisions).
--
-- There is no conversations table in the FlowGPT schema today — conversations
-- are derived (channel + contact phone). So conversation_key is a free-form
-- text key the FE constructs as "<channel>:<contact_phone>" (e.g.
-- "whatsapp:+919876543210"). This matches how the inbox already groups
-- messages on the read side.
--
-- Reads: tenant-scoped via the standard 3-source membership pattern (URA,
-- legacy user_roles, owner tenants.user_id). Inserts: same scope plus
-- user_id = auth.uid() (you can only stamp events for yourself).
-- UPDATE/DELETE: revoked — append-only.
--
-- Idempotent. No `||` inside COMMENT ON. RLS enabled.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.inbox_agent_activity (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  conversation_key text not null,
  user_id          uuid not null references auth.users(id) on delete cascade,
  event_type       text not null check (event_type in ('open','typing_start','typing_stop','reply_sent','close')),
  occurred_at      timestamptz not null default now()
);

comment on table public.inbox_agent_activity is
  'Append-only audit of inbox-conversation presence events per agent. Live presence lives in Supabase Realtime channels (ephemeral); this table is for post-incident review and collision-frequency analytics.';
comment on column public.inbox_agent_activity.conversation_key is
  'Free-form thread key the FE constructs as channel-colon-contact_phone (no conversations table exists yet).';
comment on column public.inbox_agent_activity.event_type is
  'open, typing_start, typing_stop, reply_sent, close. Driven by the inbox conversation view and the composer.';

create index if not exists idx_iaa_tenant_occurred
  on public.inbox_agent_activity(tenant_id, occurred_at desc);
create index if not exists idx_iaa_conv
  on public.inbox_agent_activity(tenant_id, conversation_key, occurred_at desc);
create index if not exists idx_iaa_user
  on public.inbox_agent_activity(user_id, occurred_at desc);

alter table public.inbox_agent_activity enable row level security;

-- ── Read: any member of the tenant can read the audit log ────────────────
drop policy if exists "iaa_tenant_read" on public.inbox_agent_activity;
create policy "iaa_tenant_read" on public.inbox_agent_activity
  for select to authenticated using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles           where user_id = auth.uid()
      union
      select id        from public.tenants              where user_id = auth.uid()
    )
  );

-- ── Insert: tenant-member + must stamp yourself ──────────────────────────
drop policy if exists "iaa_tenant_insert" on public.inbox_agent_activity;
create policy "iaa_tenant_insert" on public.inbox_agent_activity
  for insert to authenticated with check (
    user_id = auth.uid()
    and tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles           where user_id = auth.uid()
      union
      select id        from public.tenants              where user_id = auth.uid()
    )
  );

-- ── Append-only: no UPDATE / DELETE for regular roles. Service-role
--    (used by the BE for housekeeping / GDPR-style purges) bypasses RLS. ──
revoke update, delete on public.inbox_agent_activity from authenticated;
revoke update, delete on public.inbox_agent_activity from anon;
