-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 074 — Instagram channel parity (P0.9).
--
-- BRIEF: Bring Instagram to feature-parity with WhatsApp + Telegram in the
-- inbox, broadcasts, and workflow builder. Adds the three IG-unique trigger
-- surfaces:
--
--   1. Story replies          — Meta delivers `message.reply_to.story` on the
--                               existing webhook. Stored on `messages` with
--                               metadata pointing at the story media id.
--   2. Comment-to-DM          — comments arrive via `entry.changes[].field=comments`
--                               or the polling worker. New
--                               `instagram_comment_events` table de-dupes via
--                               unique (comment_id) and tracks dm_sent_at /
--                               replied_at for the 7-day private-reply window.
--   3. @mentions              — mentions arrive via `entry.changes[].field=mentions`
--                               (story / post / comment tag). New
--                               `instagram_mention_events` table records the
--                               source media + mentioner so workflows can
--                               trigger on it.
--
-- The 016 omnichannel migration already added:
--   • messages.channel ('whatsapp'|'instagram'|...)
--   • messages.platform_message_id (renamed from wa_message_id)
--   • contacts.instagram_id + index
--   • ig_comment_rules + ig_posts
--
-- 074 layers on top — additive only, idempotent, no destructive rewrites.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. messages.metadata jsonb — IG-event extensions ────────────────────────
-- Story replies need to carry the IG story media id, the story thumbnail
-- URL, and the original `reply_to.story.id`. Shared-post replies carry the
-- shared media id. Ad referrals carry the IG ad ref. Rather than fan out
-- a half-dozen typed columns we use a single jsonb bag — the inbox UI
-- reads it lazily and the executor passes it forward as the trigger payload.
--
-- Convention (loose, documented for future readers):
--   { kind: 'story_reply' | 'shared_post' | 'mention' | 'private_reply' | 'ad_referral',
--     story_id?: string, story_url?: string, media_id?: string,
--     ref?: string, source_event_id?: uuid }
--
-- Other channels can use it too (WA reply-to context, TG reply_to_message,
-- etc.) — we don't constrain the shape.
alter table public.messages
  add column if not exists metadata jsonb;

comment on column public.messages.metadata is
  'Channel-specific event metadata — IG story_reply media refs, ad referrals, reply-to context, etc. See migration 074 for shape conventions.';

-- ─── 2. instagram_comment_events — comment-to-DM source of truth ─────────────
-- Webhook + poller both write here; unique(comment_id) gates the worker
-- from doubling up. RLS scopes by tenant; the API endpoint that lists
-- comments + reply/DM actions reads via the service role from the BE.
create table if not exists public.instagram_comment_events (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  channel_id          uuid,                              -- nullable; reserved for the channels table from omnichannel-state
  post_id             text not null,                     -- IG media id of the post being commented on
  comment_id          text not null unique,              -- IG comment id — globally unique; de-dupes poller vs webhook
  parent_comment_id   text,                              -- non-null if this is a reply-to-comment
  commenter_ig_id     text,                              -- IG-scoped user id of the commenter (use to DM via /messages)
  commenter_username  text,                              -- @handle if Meta supplies it (often only on webhook, not poll)
  text                text,                              -- the comment body
  permalink           text,                              -- IG permalink to the comment
  source              text not null default 'webhook'    -- 'webhook' | 'poller'
                      check (source in ('webhook','poller')),
  ig_created_at       timestamptz,                       -- the time Meta reports for the comment
  replied_at          timestamptz,                       -- when we (the brand) replied publicly
  dm_sent_at          timestamptz,                       -- when we DM'd the commenter via private_replies
  rule_id             uuid references public.ig_comment_rules(id) on delete set null,
  raw                 jsonb,                             -- full webhook payload for forensics
  created_at          timestamptz not null default now(),
  deleted_at          timestamptz                        -- soft delete; row stays for audit
);

create index if not exists instagram_comment_events_tenant_created
  on public.instagram_comment_events(tenant_id, created_at desc) where deleted_at is null;
create index if not exists instagram_comment_events_post
  on public.instagram_comment_events(tenant_id, post_id, ig_created_at desc) where deleted_at is null;
create index if not exists instagram_comment_events_undelivered
  on public.instagram_comment_events(tenant_id) where dm_sent_at is null and replied_at is null and deleted_at is null;

alter table public.instagram_comment_events enable row level security;

drop policy if exists "Tenant reads own ig_comment_events" on public.instagram_comment_events;
create policy "Tenant reads own ig_comment_events" on public.instagram_comment_events
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

comment on table public.instagram_comment_events is
  'Inbound IG comment stream — populated by the webhook handler and the 60s comment-poller fallback worker. unique(comment_id) de-dupes across both sources. Reply / DM actions update the *_at columns. RLS scoped to the owning tenant (P0.9).';

-- ─── 3. instagram_mention_events — story / post / comment mentions ───────────
-- Meta sends `entry.changes[].field='mentions'` when someone @-tags the brand
-- handle. We surface this as a workflow trigger and as a list page so brands
-- can act on UGC. Unique(media_id, mentioner_ig_id) is best-effort dedupe —
-- a user could mention the brand twice on the same post; both should record.
create table if not exists public.instagram_mention_events (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  channel_id          uuid,
  media_id            text,                              -- the post / comment / story where the mention happened
  comment_id          text,                              -- non-null if mention came via a comment
  mention_type        text not null default 'media'      -- 'media' | 'comment' | 'story'
                      check (mention_type in ('media','comment','story')),
  mentioner_ig_id     text,
  mentioner_username  text,
  text                text,
  permalink           text,
  ig_created_at       timestamptz,
  processed_at        timestamptz,                       -- set when a workflow consumed this trigger
  raw                 jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists instagram_mention_events_tenant_created
  on public.instagram_mention_events(tenant_id, created_at desc);
create index if not exists instagram_mention_events_unprocessed
  on public.instagram_mention_events(tenant_id) where processed_at is null;

alter table public.instagram_mention_events enable row level security;

drop policy if exists "Tenant reads own ig_mention_events" on public.instagram_mention_events;
create policy "Tenant reads own ig_mention_events" on public.instagram_mention_events
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

comment on table public.instagram_mention_events is
  'Inbound @mention stream — populated by the webhook handler for the `mentions` change-field. Surfaces in the InstagramTriggersPage + the connector registry as `instagram_mention` trigger (P0.9).';

-- ─── 4. messages.content "kind" convention — story_reply / private_reply ─────
-- The `messages.content` column is jsonb. We extend the convention so the
-- inbox can render IG-specific bubbles (story-reply shows the story thumb;
-- private_reply shows "Replied to comment" label). No schema change needed —
-- this is a documentation-only comment. Convention:
--
--   { type: 'text' | 'image' | ... ,
--     text: string,
--     kind?: 'story_reply' | 'private_reply' | 'shared_post' | 'mention',
--     ... }
--
-- The kind lives on content (not metadata) because it controls rendering;
-- metadata carries the referenced ids for fetching media on demand.

-- ─── 5. instagram_comment_poller cursor — per-channel high-water mark ────────
-- The 60-second poller needs to know which comments it has already processed.
-- We can't use updated_at on the comments themselves (Meta doesn't expose it
-- reliably), so we track the most-recent ig_created_at we've seen, per tenant
-- + post. The table is intentionally small (a few rows per active tenant)
-- and lives in its own table so the comment-events table stays write-heavy
-- and append-only.
create table if not exists public.instagram_poller_cursors (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  post_id        text not null,
  last_seen_at   timestamptz,
  last_run_at    timestamptz default now(),
  primary key (tenant_id, post_id)
);

alter table public.instagram_poller_cursors enable row level security;
drop policy if exists "Tenant reads own ig_poller_cursors" on public.instagram_poller_cursors;
create policy "Tenant reads own ig_poller_cursors" on public.instagram_poller_cursors
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

comment on table public.instagram_poller_cursors is
  'Per-(tenant, post) high-water mark for the IG comment poller. Worker-only writes. Keeps comment_events small and lets us resume cleanly after a restart (P0.9).';

-- ─── 6. ig_comment_rules.last_fired_at — UX nicety ───────────────────────────
-- The IGCommentsPage shows fired_count today. Surfacing "last fired" makes
-- empty-state debugging ("why hasn't my rule triggered?") far easier. Best
-- effort; the comment-event-handler updates it on every hit.
alter table public.ig_comment_rules
  add column if not exists last_fired_at timestamptz;

comment on column public.ig_comment_rules.last_fired_at is
  'Most recent time this rule matched an incoming comment. Drives the "Last triggered Xm ago" label on the rules page (P0.9).';

-- ─── Sanity ──────────────────────────────────────────────────────────────────
-- \d+ public.instagram_comment_events
-- \d+ public.instagram_mention_events
-- \d+ public.instagram_poller_cursors
-- select column_name from information_schema.columns
--   where table_name='messages' and column_name='metadata';
