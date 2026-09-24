-- Google Business Profile (GBP) connection — additive, idempotent.
--
-- GBP gets its OWN token column, NOT the shared google_refresh_token. Reusing
-- google_refresh_token would clobber the tenant's Gmail/Sheets/Calendar grant:
-- GBP is authorised with a DIFFERENT scope (business.manage) via a SEPARATE
-- consent screen, so the two refresh tokens must live side by side.
--
-- gbp_refresh_token is stored ENCRYPTED at rest (AES-256-GCM via
-- src/lib/app-secrets encryptSecret — the same at-rest scheme the SEO/Search
-- Console connector uses, since GBP runs under that same Google OAuth client) —
-- never a bare Google token. gbp_email is the account that authorised, shown as
-- the "Connected as" line. Both nullable; NULL = not connected. Non-destructive.

alter table public.tenants add column if not exists gbp_refresh_token text;
alter table public.tenants add column if not exists gbp_email        text;
