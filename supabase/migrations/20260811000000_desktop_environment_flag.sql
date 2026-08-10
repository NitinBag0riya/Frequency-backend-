-- Global routing flag for Frequency Desktop: which backend installs talk to.
-- Read (public, no auth) by GET /api/desktop/runtime-config; written by
-- super-admins via the existing PATCH /api/super-admin/feature-flags/desktop_environment
-- (value_json is already whitelisted there). Routing only — never a secret.
-- Default prod so unset never points installs at beta.
insert into public.feature_flags (key, is_enabled, value_json, description)
values (
  'desktop_environment',
  true,
  jsonb_build_object('value', 'prod'),
  'Frequency Desktop → backend installs talk to (prod | beta). Routing only, no secrets.'
)
on conflict (key) do nothing;
