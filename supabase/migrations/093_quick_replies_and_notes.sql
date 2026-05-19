-- 093_quick_replies_and_notes
--
-- Phase 1A of the post-deploy roadmap (docs/ROADMAP.md): inbox-quality
-- features that have outsized agent-retention impact and share the
-- conversation-composer surface.
--
-- Two feature families in one migration because they live next to each
-- other in the UI (composer extensions) and share helper code paths
-- (variable interpolation, audit logging).
--
-- ─── 1. Quick Replies ─────────────────────────────────────────────────────
--
-- Three-tier library — `scope` enum decides who sees the entry:
--   workspace  → all agents on the tenant; admin-curated
--   team       → agents in a specific team (scope_target_id = team_id)
--   personal   → only the creator (scope_target_id = user_id)
--
-- `body_template` is a string with double-mustache placeholders
-- ({{contact.first_name}}, {{deal.amount_inr | format_inr}}, ...). The
-- BE expands placeholders at insert time, NOT at save time, so the
-- variable set can evolve without invalidating saved templates.
--
-- `applicable_stages` + `applicable_intents` drive the stage-aware AI
-- ranking documented in ROADMAP.md §4.1A. When a conversation has a
-- linked Pipeline deal in stage "Negotiation" + the inbound message
-- has intent "pricing", quick replies tagged with that stage AND/OR
-- intent rank above generic ones.
--
-- `usage_count` + `last_used_at` are denormalized counters maintained
-- by INSERTs into quick_reply_usage. Cheap to read on the picker for
-- "most used by you" sorting.
--
-- ─── 2. Internal Notes ────────────────────────────────────────────────────
--
-- Polymorphic targets via (target_type, target_id) since a note can be
-- attached to a conversation, a specific message, a deal card, or a
-- contact. RLS policies discriminate per target_type so the right
-- audit boundary applies.
--
-- `mentions` is a uuid[] of mentioned user_ids — denormalized for fast
-- "show me notes I'm mentioned in" queries. The canonical source of
-- delivery state is note_mentions (created on note insert by a trigger).
--
-- `visibility = 'team'` means visible to all agents on the tenant;
-- 'private' restricts to creator + mentioned users.
--
-- All tables ENABLE row-level security; policies attached at the end.

set check_function_bodies = off;

-- ─── 1. quick_replies ─────────────────────────────────────────────────────

create table if not exists public.quick_replies (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  scope               text not null check (scope in ('workspace', 'team', 'personal')),
  -- scope_target_id semantics:
  --   workspace → must be NULL
  --   team      → team_id (FK to public.teams when that table exists; soft for now)
  --   personal  → user_id
  scope_target_id     uuid,
  title               text not null check (length(title) between 1 and 80),
  body_template       text not null check (length(body_template) between 1 and 4000),
  hotkey              text check (hotkey is null or length(hotkey) <= 24),
  variables_required  text[] not null default '{}',  -- ['{{contact.first_name}}', ...]
  applicable_stages   text[] not null default '{}',  -- ['Lead', 'Negotiation', ...]
  applicable_intents  text[] not null default '{}',  -- ['pricing', 'refund', ...]
  usage_count         bigint not null default 0 check (usage_count >= 0),
  last_used_at        timestamptz,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- scope = 'workspace' must have NULL target; others must have non-NULL.
  constraint quick_replies_scope_target_consistency check (
    (scope = 'workspace' and scope_target_id is null)
    or (scope in ('team', 'personal') and scope_target_id is not null)
  )
);

create index if not exists idx_quick_replies_tenant_scope
  on public.quick_replies(tenant_id, scope);

-- Personal scope: index on the user's own snippets for fast picker fetch.
create index if not exists idx_quick_replies_personal_user
  on public.quick_replies(tenant_id, scope_target_id)
  where scope = 'personal';

-- Hotkey lookup (when an agent types '/foo'). Unique per (tenant, scope,
-- scope_target) so personal 'foo' and a different agent's 'foo' don't collide.
create unique index if not exists ux_quick_replies_hotkey
  on public.quick_replies(tenant_id, scope, coalesce(scope_target_id, '00000000-0000-0000-0000-000000000000'), lower(hotkey))
  where hotkey is not null;

comment on table public.quick_replies is
  'Composer snippet library. 3-tier scope (workspace/team/personal). body_template uses {{variable}} placeholders expanded at insert-time. applicable_stages + applicable_intents drive AI ranking in the picker.';

-- Per-use audit log. Drives usage_count denormalization + "which templates
-- get edited heavily, suggesting they need rewriting" insight surface.

create table if not exists public.quick_reply_usage (
  id              uuid primary key default gen_random_uuid(),
  quick_reply_id  uuid not null references public.quick_replies(id) on delete cascade,
  conversation_id uuid,  -- soft FK; conversations table lives in messaging schema
  agent_id        uuid references auth.users(id) on delete set null,
  used_at         timestamptz not null default now(),
  edited          boolean not null default false   -- did agent modify the body before sending?
);

create index if not exists idx_quick_reply_usage_template_recent
  on public.quick_reply_usage(quick_reply_id, used_at desc);

comment on table public.quick_reply_usage is
  'One row per send. `edited=true` → agent modified the template body before send — high edit-rate signals a template that needs rewriting (surfaced in the admin Insights tab).';

-- Maintain quick_replies.usage_count + last_used_at via trigger so the
-- picker can sort "most used" without a JOIN.

create or replace function public.tg_quick_reply_usage_increment()
returns trigger language plpgsql as $$
begin
  update public.quick_replies
     set usage_count  = usage_count + 1,
         last_used_at = new.used_at
   where id = new.quick_reply_id;
  return new;
end;
$$;

drop trigger if exists trg_quick_reply_usage_increment on public.quick_reply_usage;
create trigger trg_quick_reply_usage_increment
  after insert on public.quick_reply_usage
  for each row execute function public.tg_quick_reply_usage_increment();

-- ─── 2. conversation_notes ────────────────────────────────────────────────

create table if not exists public.conversation_notes (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  target_type     text not null check (target_type in ('conversation', 'message', 'deal', 'contact')),
  target_id       uuid not null,                -- polymorphic; not FK-enforced
  body            text not null check (length(body) between 1 and 8000),
  mentions        uuid[] not null default '{}', -- denormalized; canonical = note_mentions
  attachments     jsonb not null default '[]'::jsonb,
  visibility      text not null default 'team'
                  check (visibility in ('team', 'private')),
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz,                  -- agents can mark a note "addressed"
  resolved_by     uuid references auth.users(id) on delete set null
);

-- Hot path: "show me notes attached to this conversation/deal/contact".
create index if not exists idx_conversation_notes_target
  on public.conversation_notes(tenant_id, target_type, target_id, created_at desc);

-- Filter unresolved notes (badge counts on deal cards).
create index if not exists idx_conversation_notes_unresolved
  on public.conversation_notes(tenant_id, target_type, target_id)
  where resolved_at is null;

comment on table public.conversation_notes is
  'Internal-only annotations. Polymorphic target (conversation/message/deal/contact). Mentions trigger note_mentions rows + push notifications. visibility=private hides from team unless the user is mentioned.';

-- One row per (note, mentioned_user). Drives notification routing
-- (in-app bell, push, email) and read receipts.

create table if not exists public.note_mentions (
  id                  uuid primary key default gen_random_uuid(),
  note_id             uuid not null references public.conversation_notes(id) on delete cascade,
  mentioned_user_id   uuid not null references auth.users(id) on delete cascade,
  notified_at         timestamptz,
  read_at             timestamptz,
  push_sent_at        timestamptz,
  email_sent_at       timestamptz
);

create unique index if not exists ux_note_mentions_note_user
  on public.note_mentions(note_id, mentioned_user_id);

create index if not exists idx_note_mentions_user_unread
  on public.note_mentions(mentioned_user_id, read_at)
  where read_at is null;

comment on table public.note_mentions is
  'Fan-out row per @mention in a note. notified_at / push_sent_at / email_sent_at let the notification worker dedupe channels.';

-- Auto-create note_mentions rows from the denormalized mentions[] on
-- conversation_notes insert. Keeps the two in sync without app-layer
-- juggling.

create or replace function public.tg_conversation_notes_fanout_mentions()
returns trigger language plpgsql as $$
declare
  uid uuid;
begin
  if new.mentions is not null then
    foreach uid in array new.mentions loop
      insert into public.note_mentions (note_id, mentioned_user_id)
      values (new.id, uid)
      on conflict (note_id, mentioned_user_id) do nothing;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_conversation_notes_fanout_mentions on public.conversation_notes;
create trigger trg_conversation_notes_fanout_mentions
  after insert on public.conversation_notes
  for each row execute function public.tg_conversation_notes_fanout_mentions();

-- ─── 3. RLS ───────────────────────────────────────────────────────────────
--
-- Pattern matches the existing codebase (see migrations 079, 087): a row
-- is visible if its tenant_id appears in the caller's
-- user_role_assignments OR user_roles. The BE service-role context
-- bypasses RLS for system-level writes (worker tasks, webhook handlers).

-- Reusable membership sub-query, repeated inline below since Postgres
-- policy expressions are simpler than functions for this case and match
-- the precedent in crm_deals + agency_members.

alter table public.quick_replies enable row level security;
alter table public.quick_reply_usage enable row level security;
alter table public.conversation_notes enable row level security;
alter table public.note_mentions enable row level security;

-- quick_replies: members of the tenant can read all workspace + team
-- snippets + their own personal snippets. Personal snippets are private
-- to their owner.
drop policy if exists "quick_replies_tenant_rw" on public.quick_replies;
create policy "quick_replies_tenant_rw" on public.quick_replies
  for all to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
    and (
      scope in ('workspace', 'team')
      or (scope = 'personal' and scope_target_id = auth.uid())
    )
  )
  with check (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
    and (
      scope in ('workspace', 'team')   -- BE additionally gates writes on role
      or (scope = 'personal' and scope_target_id = auth.uid())
    )
  );

-- quick_reply_usage: tenant-scoped via the parent quick_replies row.
-- Read for all tenant members (drives admin Insights); insert by the
-- agent themselves.
drop policy if exists "quick_reply_usage_tenant_read" on public.quick_reply_usage;
create policy "quick_reply_usage_tenant_read" on public.quick_reply_usage
  for select to authenticated
  using (
    exists (
      select 1 from public.quick_replies qr
      where qr.id = quick_reply_usage.quick_reply_id
        and qr.tenant_id in (
          select tenant_id from public.user_role_assignments where user_id = auth.uid()
          union
          select tenant_id from public.user_roles where user_id = auth.uid()
        )
    )
  );

drop policy if exists "quick_reply_usage_self_insert" on public.quick_reply_usage;
create policy "quick_reply_usage_self_insert" on public.quick_reply_usage
  for insert to authenticated
  with check (
    agent_id = auth.uid()
    and exists (
      select 1 from public.quick_replies qr
      where qr.id = quick_reply_usage.quick_reply_id
        and qr.tenant_id in (
          select tenant_id from public.user_role_assignments where user_id = auth.uid()
          union
          select tenant_id from public.user_roles where user_id = auth.uid()
        )
    )
  );

-- conversation_notes: tenant-scoped read; private notes only visible to
-- creator + mentions. Insert by any tenant member; update/delete by
-- creator only (BE additionally allows admin overrides).
drop policy if exists "conversation_notes_tenant_read" on public.conversation_notes;
create policy "conversation_notes_tenant_read" on public.conversation_notes
  for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
    and (
      visibility = 'team'
      or created_by = auth.uid()
      or auth.uid() = any(mentions)
    )
  );

drop policy if exists "conversation_notes_self_write" on public.conversation_notes;
create policy "conversation_notes_self_write" on public.conversation_notes
  for insert to authenticated
  with check (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
    and created_by = auth.uid()
  );

drop policy if exists "conversation_notes_self_update" on public.conversation_notes;
create policy "conversation_notes_self_update" on public.conversation_notes
  for update to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
    and created_by = auth.uid()
  );

drop policy if exists "conversation_notes_self_delete" on public.conversation_notes;
create policy "conversation_notes_self_delete" on public.conversation_notes
  for delete to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
    and created_by = auth.uid()
  );

-- note_mentions: a user can only see/update their own mention rows.
drop policy if exists "note_mentions_self_rw" on public.note_mentions;
create policy "note_mentions_self_rw" on public.note_mentions
  for all to authenticated
  using (mentioned_user_id = auth.uid())
  with check (mentioned_user_id = auth.uid());
