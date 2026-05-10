-- ─── tenants.slug — workspace URL identity ────────────────────────────
--
-- The frontend now routes tenant pages under /{orgSlug}/* instead of
-- /tenant/* (Slack/GitHub/Linear pattern: workspace identity in the URL).
-- This requires a per-tenant slug that is:
--   - unique (so the URL refers to exactly one workspace)
--   - URL-safe ([a-z0-9-], 3-32 chars, no leading/trailing hyphen)
--   - non-reserved (can't collide with existing top-level routes like
--     'naruto', 'home', 'auth', 'api', 'accept-invite', etc.)
--
-- Rename strategy: out of scope for this migration. v1 = slug is set
-- once at tenant creation. v2 (when product needs it) = slug-history
-- table for redirect grace period + Settings → Workspace rename UI.
--
-- All steps idempotent — re-running this migration is a no-op.

-- ── 1. Add the column (NULLable initially so the backfill below can run) ──
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS slug text;

-- ── 2. Backfill — generate slug from business_name (or fallback) ──────
-- Algorithm:
--   - lowercase
--   - replace any non-[a-z0-9] run with single hyphen
--   - trim leading/trailing hyphens
--   - if empty after slugify, fall back to 'workspace-' || left(id::text, 8)
--   - clamp to 32 chars
-- Collision handling done in a second pass below.
UPDATE public.tenants
SET slug = COALESCE(
  NULLIF(
    LEFT(
      REGEXP_REPLACE(
        TRIM(BOTH '-' FROM
          REGEXP_REPLACE(LOWER(COALESCE(business_name, '')), '[^a-z0-9]+', '-', 'g')
        ),
        '^-+|-+$', '', 'g'
      ),
      32
    ),
    ''
  ),
  'workspace-' || LEFT(id::text, 8)
)
WHERE slug IS NULL OR slug = '';

-- ── 3. Resolve collisions — suffix with -2, -3, etc. ──────────────────
-- ROW_NUMBER over each (slug) group; rows after the first get '-N' appended.
WITH ranked AS (
  SELECT id, slug,
         ROW_NUMBER() OVER (PARTITION BY slug ORDER BY created_at NULLS LAST, id) AS rn
  FROM public.tenants
)
UPDATE public.tenants t
SET slug = CASE
  WHEN r.rn = 1 THEN t.slug
  ELSE LEFT(t.slug, 28) || '-' || r.rn  -- leave room for the suffix within 32 cap
END
FROM ranked r
WHERE t.id = r.id AND r.rn > 1;

-- ── 4. Lock down the column — NOT NULL + UNIQUE + CHECK shape ────────
ALTER TABLE public.tenants
  ALTER COLUMN slug SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_slug_shape_check
    CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$' AND length(slug) BETWEEN 3 AND 32);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_unique_idx ON public.tenants (slug);

-- ── 5. Reserved-slug enforcement ──────────────────────────────────────
-- These collide with frontend top-level routes; allowing them as a tenant
-- slug would route /api/* (etc.) into the slug resolver and break things
-- in non-obvious ways. Enforced via CHECK so direct DB inserts can't
-- bypass the application-level validation either.
DO $$ BEGIN
  ALTER TABLE public.tenants
    ADD CONSTRAINT tenants_slug_not_reserved_check
    CHECK (slug NOT IN (
      'api', 'naruto', 'admin', 'auth', 'home', 'accept-invite',
      'app', 'console', 'login', 'signup', 'settings', 'help',
      'blog', 'docs', 'www', 'mail', 'ftp', 'public', 'root',
      'support', 'status', 'onboarding-new', 'webhook', 'webhooks',
      'static', 'assets', 'cdn', '_next', 'pricing', 'features',
      'tenant', 'tenants', 'workspace', 'workspaces'
    ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.tenants.slug IS
  'URL-safe workspace identifier. Used by the frontend to route /{slug}/inbox etc. '
  'Auto-generated from business_name at tenant creation, made unique with -N suffix. '
  'Reserved words (api, naruto, admin, …) refused at CHECK level.';

-- ── 6. Quick verification query (manual run after deploy) ─────────────
-- select id, business_name, slug from public.tenants order by created_at;
-- All slugs must be NOT NULL, must match shape, and must be unique.
