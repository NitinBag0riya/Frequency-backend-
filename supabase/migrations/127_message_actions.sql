-- ============================================================
-- 127_message_actions.sql — reactions + reply-to threading
-- ============================================================
--
-- Inspired by wacrm's 009_message_actions: bring two missing inbox
-- primitives into Frequency.
--
--   1. Reactions   — emoji reactions on a message. Stored in their own
--                    table, NOT shoehorned into messages.content as fake
--                    text rows (which the prior webhook path would do
--                    if we just dropped them into the messages insert).
--
--   2. Reply-to    — when a customer (or agent) replies to a specific
--                    message, capture the parent's platform_message_id
--                    so the inbox can render a quoted preview above the
--                    new bubble.
--
-- Design choices
--
--   - Reactions live in `message_reactions`, not in `messages.content`.
--     Two reasons: (a) reactions change/disappear independently of the
--     parent message and we want UPDATE/DELETE semantics, not insert
--     more rows; (b) keeping them out of `messages` means existing
--     workflow triggers, analytics, conversation counts, and unread
--     logic don't get distorted by a stream of "messages" that aren't
--     actually messages.
--
--   - `reply_to_platform_message_id` (text) instead of an FK to
--     messages.id (uuid). The webhook tells us about replies by Meta's
--     wamid — the parent row may not exist yet (race window), and we
--     don't want a NOT VALID FK or a constraint we can't enforce. The
--     UI does the join client-side from the already-loaded message
--     set, falling back to "(message)" if the parent isn't loaded.
--
--   - One reaction per (message, contact_phone, direction). WhatsApp
--     itself only allows a single reaction per (user, message) — a
--     second tap replaces the emoji, removing means sending the empty
--     string. We mirror that with a UNIQUE partial index so the
--     server doesn't have to do its own dedupe.
--
--   - RLS via the parent message: a reaction is visible iff the
--     viewer's tenant matches the message's tenant. No separate
--     tenant_id column on message_reactions — denormalising it would
--     require a trigger to keep in sync with the parent, and the
--     join through messages is cheap (FK + index).
--
-- Idempotent — safe to re-run if a prior partial apply left things
-- half-built. Every ALTER/CREATE is guarded with IF NOT EXISTS.

-- ── messages.reply_to_platform_message_id ────────────────────────────────
alter table public.messages
  add column if not exists reply_to_platform_message_id text;

comment on column public.messages.reply_to_platform_message_id is
  'When set, this message is a reply to the parent identified by '
  'platform_message_id (Meta wamid for WhatsApp, mid for Instagram, '
  'message_id for Telegram). Inbox renders a quoted preview above the '
  'bubble. Stored as text not FK because the parent may be inserted '
  'after the reply during a webhook race window. Set on inbound from '
  'msg.context.id (WA), on outbound when the agent uses "Reply" in '
  'the composer.';

create index if not exists messages_reply_to_idx
  on public.messages (tenant_id, reply_to_platform_message_id)
  where reply_to_platform_message_id is not null;

-- ── message_reactions ───────────────────────────────────────────────────
create table if not exists public.message_reactions (
  id                   uuid primary key default gen_random_uuid(),
  message_id           uuid not null references public.messages(id) on delete cascade,
  -- Denormalised tenant_id so RLS doesn't need a join through messages
  -- on every read. Kept in sync by the webhook + react route (both
  -- already know the tenant when inserting). FK still goes through
  -- messages.id so a deleted message cascades.
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  contact_phone        text not null,
  direction            text not null check (direction in ('inbound', 'outbound')),
  emoji                text not null,
  -- Meta gives reactions their own wamid in some delivery shapes; keep
  -- it so status callbacks for an outbound reaction (rare today, but
  -- spec-permitted) can find the row.
  platform_reaction_id text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists message_reactions_message_idx
  on public.message_reactions (message_id, created_at desc);

create index if not exists message_reactions_tenant_idx
  on public.message_reactions (tenant_id, created_at desc);

-- One reaction per (message, contact, direction). Re-acting REPLACES
-- the emoji via an UPSERT; un-acting DELETEs the row.
create unique index if not exists message_reactions_unique
  on public.message_reactions (message_id, contact_phone, direction);

alter table public.message_reactions enable row level security;

drop policy if exists "Tenants manage own message reactions" on public.message_reactions;
create policy "Tenants manage own message reactions"
  on public.message_reactions
  for all
  using (
    exists (
      select 1 from public.tenants t
      where t.id = message_reactions.tenant_id
        and t.user_id = auth.uid()
    )
  );

-- updated_at maintenance — intentionally NOT a trigger. The reaction
-- route is the only writer; it can SET updated_at = now() when it
-- UPSERTs. A trigger here would also need a helper function that may
-- not exist in every environment (the prior `update_updated_at_column`
-- check tripped on a search-path quirk during one push). Keeping it
-- as a defaulted-on-insert column is sufficient because reactions are
-- replace-or-delete semantics; we rarely care WHEN the emoji was last
-- swapped, and if we ever do we can add the trigger in a follow-up
-- migration that owns its own function definition.

-- ── Realtime publication ────────────────────────────────────────────────
-- The InboxPage already subscribes to public.messages; reactions get
-- their own channel so an emoji tap doesn't re-trigger a full message
-- re-render. supabase_realtime is the default publication; if a
-- self-hosted instance renamed it, the add silently no-ops.
do $$
begin
  begin
    alter publication supabase_realtime add table public.message_reactions;
  exception when others then null;
  end;
end $$;

-- Replica identity full so the realtime payload includes the deleted
-- row's columns on a DELETE — the UI needs message_id + contact_phone
-- to know which chip to remove.
alter table public.message_reactions replica identity full;
