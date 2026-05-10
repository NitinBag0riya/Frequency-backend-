-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 023 — restrict ingest_token visibility via column-level GRANT
--
-- Problem:
--   Migration 022 added `lead_tables.ingest_token` as a regular column. The
--   existing RLS policy on `lead_tables` (013_lead_tables_tenant_id.sql)
--   permits SELECT * to anyone in `user_roles` for the tenant. That means a
--   `viewer` / `analyst` / `support_agent` role can read the token via
--   direct supabase-js select and abuse it as a write capability that
--   completely bypasses their `leads:edit` permission gate.
--
-- Fix:
--   Revoke column-level SELECT on `ingest_token` from the `authenticated`
--   role. Token can still be read by the service role (used by our server)
--   and by tenant owners via the `auth.uid()` RLS path, BUT — Supabase RLS
--   evaluates row-level policies independent of column GRANTs, so we also
--   need to ensure the FE never tries to read it directly. The server-only
--   read path is GET /api/lead-tables/:id which is gated by checkPermission
--   ('leads', 'view'). For surfacing it on the Source tab (where the user
--   does need to copy it), we tighten the API gate to 'edit'.
--
-- Net effect:
--   - Service role reads the column for the public ingest endpoint match.
--   - Tenant owner reads via `auth.uid()` ownership path (table-level RLS).
--   - All other roles can SELECT the rest of the table but NOT this column.
--   - The server's GET /api/lead-tables/:id continues to return the column
--     because it uses the service-role client, but the *route* itself is
--     now gated to leads:edit (see leads.ts) so viewers can't pull it
--     through the API either.
-- ─────────────────────────────────────────────────────────────────────────────

revoke select (ingest_token) on public.lead_tables from authenticated;
revoke select (ingest_token) on public.lead_tables from anon;

-- Service role keeps full access (it's the SUPERUSER bypass that the
-- backend uses anyway). No grant needed — postgres role has it implicitly.

comment on column public.lead_tables.ingest_token is
  'Per-table webhook ingest credential. Only readable via the server endpoint
   GET /api/lead-tables/:id which requires leads:edit. Never expose directly
   to the FE supabase-js client.';
