-- Tenant integrations (WhatsApp, Google Drive, Google Calendar, Google Sheets, Razorpay, etc.)
CREATE TABLE IF NOT EXISTS tenant_integrations (
  id            uuid default gen_random_uuid() primary key,
  tenant_id     uuid references tenants(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete cascade not null,
  key           text not null,   -- 'google_drive' | 'google_calendar' | 'google_sheets' | 'razorpay'
  status        text default 'active',
  label         text,            -- human-readable connected account / label
  config        jsonb default '{}',
  connected_at  timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (user_id, key)
);

ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_select" ON tenant_integrations FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "owner_insert" ON tenant_integrations FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "owner_update" ON tenant_integrations FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "owner_delete" ON tenant_integrations FOR DELETE USING (user_id = auth.uid());
