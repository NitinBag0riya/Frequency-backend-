-- ─────────────────────────────────────────────────────────────────────────────
-- wa_broadcast_log — audit trail for outbound WhatsApp campaign sends.
--
-- POST /api/wa_broadcast_log/wa-send inserts one row per send, records the cohort +
-- template body used + recipients sent. Individual WA messages are still
-- persisted per-recipient in the existing `messages` table by the sender.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.wa_broadcast_log (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants(id) on delete cascade,
  cohort_id     text,
  template_body text        not null,
  sent_count    integer     not null default 0,
  sent_at       timestamptz not null default now(),
  sent_by       text                                              -- user email
);

create index if not exists wa_broadcast_log_tenant_sent_idx
  on public.wa_broadcast_log (tenant_id, sent_at desc);

alter table public.wa_broadcast_log enable row level security;

do $$ begin
  create policy wa_broadcast_log_tenant_read on public.wa_broadcast_log
    for select to public
    using (tenant_id in (select current_user_tenant_ids()));
exception when duplicate_object then null; end $$;
