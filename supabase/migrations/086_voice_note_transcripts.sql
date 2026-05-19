-- ─────────────────────────────────────────────────────────────────────────────
-- P2 #20 — Voice note transcripts (inbox)
--
-- One row per inbound voice-note message. The voice-note-transcribe worker
-- fills this in asynchronously after the messages row lands; the inbox FE
-- looks up the transcript when it renders an audio bubble and shows the text
-- inline under the player.
--
-- Why a separate table (not a column on messages):
--   • messages.content is jsonb, size-capped at 64 KB by migration 050. A
--     long voice note transcript can comfortably bust that cap if we shove
--     the text inline alongside the original payload.
--   • Transcription is async + retryable. A dedicated row with a status
--     column lets the FE show a "Transcribing…" spinner without us having
--     to mutate the messages row (which would invalidate the inbox cache).
--   • Per-row cost tracking (cost_paise) so the operator dashboard can see
--     what voice transcription is costing per tenant.
--
-- Worker contract:
--   • Worker inserts a row with status='pending' on enqueue (UPSERT keyed on
--     message_id so retries are idempotent).
--   • On success: status='completed', text_raw, language_detected,
--     duration_sec, cost_paise, completed_at populated.
--   • On permanent failure (corrupted audio, unsupported format, OpenAI
--     5xx exhausted): status='failed', error set. Worker does NOT retry
--     more than 2 attempts — Whisper failures are mostly permanent.
--
-- FE contract:
--   • Inbox bubble fetches /api/messages/:id/transcript when the user clicks
--     "Show transcript" on an audio message. 404 means no transcript exists
--     (e.g. job hasn't started yet — happens within the first ~5s of an
--     inbound voice note).
--   • The conversation-list preview substitutes the first 60 chars of
--     transcript text for "🎤 Voice note" when status='completed'.
--
-- RLS: read-only for tenant members. Writes are SERVICE-ROLE only (the
-- worker) and we revoke INSERT/UPDATE/DELETE from authenticated + anon so
-- the FE physically cannot forge transcripts.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.voice_note_transcripts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  message_id        uuid not null references public.messages(id) on delete cascade,
  -- Provider tag — 'openai-whisper-1' for OpenAI Whisper API, future:
  -- 'whisper-large-v3' for self-hosted, 'assemblyai' if we ever fall over.
  -- Kept as free text instead of an enum so we can A/B providers without
  -- a schema migration.
  provider          text not null,
  -- Language code from the provider (Whisper returns ISO 639-1 like 'en',
  -- 'hi'). Null if the model couldn't detect or the call failed.
  language_detected text,
  -- The transcript itself. Worker stores the raw model output; FE handles
  -- display. No max length here — the messages.content cap doesn't apply
  -- to this table, and Postgres TOAST handles arbitrarily long text.
  text_raw          text not null,
  -- Audio duration in seconds (from the provider response or ffprobe).
  -- Used by FE to render the "X-second voice note" footnote AND by the
  -- worker to compute cost.
  duration_sec      numeric(8,2),
  -- Cost in Indian paise (₹1 = 100 paise). Stored as bigint so we can sum
  -- across thousands of transcripts without precision loss. The worker
  -- computes this as duration_sec * OPENAI_WHISPER_USD_PER_MINUTE * USDINR.
  cost_paise        bigint default 0,
  -- Lifecycle:
  --   pending   = job enqueued, transcription in flight. FE shows spinner.
  --   completed = text_raw populated, language_detected set, cost recorded.
  --   failed    = error set; FE shows "Transcription unavailable" subtle note.
  status            text not null default 'pending'
                    check (status in ('pending', 'completed', 'failed')),
  error             text,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  -- One transcript per message. UPSERT on message_id makes the worker safe
  -- against BullMQ retries (re-enqueues collapse to the same row).
  unique (message_id)
);

-- Per-tenant time-ordered scans (operator dashboard "recent voice notes").
create index if not exists idx_vnt_tenant on public.voice_note_transcripts(tenant_id, created_at desc);
-- Single-row lookup by message_id — the hot path from the inbox FE
-- (GET /api/messages/:id/transcript hits this).
create index if not exists idx_vnt_message on public.voice_note_transcripts(message_id);

alter table public.voice_note_transcripts enable row level security;

-- SELECT policy — tenant members can read their own transcripts. Mirrors the
-- multi-source tenant membership pattern used elsewhere (user_role_assignments
-- for RBAC, user_roles for legacy single-role, tenants.user_id for owner).
drop policy if exists "vnt_tenant_read" on public.voice_note_transcripts;
create policy "vnt_tenant_read" on public.voice_note_transcripts for select to authenticated
  using (tenant_id in (
    select tenant_id from public.user_role_assignments where user_id = auth.uid()
    union select tenant_id from public.user_roles where user_id = auth.uid()
    union select id from public.tenants where user_id = auth.uid()
  ));

-- Hard-revoke writes from authenticated + anon. The worker uses the
-- service-role key which bypasses RLS, so this is purely a defense-in-depth
-- guarantee that no FE-token-holder can ever forge a transcript row.
revoke insert, update, delete on public.voice_note_transcripts from authenticated;
revoke insert, update, delete on public.voice_note_transcripts from anon;
