-- P0-5 + P0-7 prerequisites — unique constraints needed for idempotent
-- upserts on the WhatsApp template & message paths.

-- ──────────────────────────────────────────────────────────────────────
-- wa_templates: tenant + name + language must be unique so the sync
-- worker (workers/template-sync.ts) and the create endpoint
-- (/api/wa-templates POST) can `.upsert(..., { onConflict: 'tenant_id,name,language' })`
-- and merge fresh template content without spawning duplicate rows.
-- ──────────────────────────────────────────────────────────────────────
create unique index if not exists wa_templates_tenant_name_lang
  on public.wa_templates (tenant_id, name, language);

-- ──────────────────────────────────────────────────────────────────────
-- messages: tenant + platform_message_id must be unique for non-null
-- platform_message_ids so:
--   1. The inbound webhook can `.upsert(..., { onConflict: 'tenant_id,platform_message_id' })`
--      and absorb Meta's aggressive retries without creating duplicate
--      inbound rows.
--   2. The status webhook can reliably target the outbound row by
--      platform_message_id WHERE tenant_id (defence against
--      cross-tenant platform_message_id collisions).
-- Partial index — pre-fetch outbound rows (and stub queued rows) have
-- platform_message_id IS NULL and shouldn't enter this index.
-- ──────────────────────────────────────────────────────────────────────
create unique index if not exists messages_tenant_platform_id
  on public.messages (tenant_id, platform_message_id)
  where platform_message_id is not null;

-- Bonus: a regular index on (tenant_id, platform_message_id) — the
-- partial unique above already serves status-webhook UPDATE lookups
-- efficiently. No additional index needed.
