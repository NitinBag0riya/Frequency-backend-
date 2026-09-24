-- Google Search Console connection, one row per tenant (additive, idempotent).
--
-- Stores the OAuth refresh token (ENCRYPTED at rest — never a bare Google token)
-- plus the provisioned state: which site URL we claimed, whether siteVerification
-- confirmed it, and when the sitemap was submitted. The verification META token
-- itself is NOT the secret here (it ships publicly in the storefront <head> via
-- storefront-api seo.googleVerification); the refresh token is.
--
-- Nothing here is destructive: table + RLS only, all guarded IF NOT EXISTS.

create table if not exists public.tenant_gsc (
  tenant_id            uuid primary key references public.tenants(id) on delete cascade,
  refresh_token_enc    text,                       -- AES-256-GCM (app-secrets.encryptSecret); never plaintext
  google_email         text,                       -- the Google account that authorised (for the "Connected as" line)
  site_url             text,                        -- the URL-prefix property we claimed (e.g. https://order.getfrequency.app/acme/)
  verified             boolean not null default false,
  verification_meta    text,                        -- the google-site-verification content token we wrote to storefront seo
  sitemap_url          text,
  sitemap_submitted_at timestamptz,
  connected_at         timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Service-role only: this holds a decryptable refresh token, so no tenant/user
-- session should ever read it directly. RLS on + no policies = deny-all; the
-- server reaches it with the service key, which bypasses RLS.
alter table public.tenant_gsc enable row level security;
