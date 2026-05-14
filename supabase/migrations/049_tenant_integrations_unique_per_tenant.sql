-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 049 — tenant_integrations uniqueness must be (tenant_id, key)
--
-- Bug: the original UNIQUE (user_id, key) means if two users at the same
-- tenant connect the same provider (e.g. both connect google_drive), the
-- second user's connection silently shadows the first at the application
-- level — but more importantly, removing one user's connection wipes the
-- other's because the app keys lookups by tenant. Worse: a workspace owner
-- transferring to a new account loses all integrations because they were
-- bound to the previous user_id.
--
-- Fix: integrations are tenant-owned, not user-owned. Constraint becomes
-- UNIQUE (tenant_id, key). Backfill NULL tenant_ids from tenants.user_id
-- correlation. Then SET NOT NULL.
--
-- Threat model trace:
--   tenant T has user_id O (owner) and member M.
--   M connects 'google_calendar' → row { tenant_id: T, user_id: M, key: gcal }
--   O connects 'google_calendar' → row { tenant_id: T, user_id: O, key: gcal }
--   Old constraint allowed both (different user_id). New constraint blocks
--   the second insert — by design — and the app upserts on (tenant_id, key).
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Backfill NULL tenant_id from tenants ──────────────────────────────
-- For any row that lost its tenant_id (or was inserted before tenant_id
-- existed in 005), pick the user's tenant. LIMIT 1 because if a user owns
-- multiple tenants the integration is ambiguous — we pick one and surface
-- via the unique-violation handling below.
UPDATE public.tenant_integrations ti
   SET tenant_id = sub.tenant_id
  FROM (
    SELECT DISTINCT ON (t.user_id) t.user_id, t.id AS tenant_id
      FROM public.tenants t
     ORDER BY t.user_id, t.created_at ASC
  ) sub
 WHERE ti.tenant_id IS NULL
   AND ti.user_id   = sub.user_id;

-- ── 2. Drop any rows still missing tenant_id (orphaned integrations
--    belonging to users with zero tenants — they cannot legally exist).
DELETE FROM public.tenant_integrations WHERE tenant_id IS NULL;

-- ── 3. De-dup any pre-existing (tenant_id, key) collisions BEFORE we add
--    the constraint, otherwise the ALTER will abort. Keep the most recent.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY tenant_id, key
           ORDER BY connected_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
         ) AS rn
    FROM public.tenant_integrations
)
DELETE FROM public.tenant_integrations
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── 4. Drop the old (user_id, key) unique constraint ─────────────────────
DO $$
DECLARE c_name text;
BEGIN
  SELECT con.conname INTO c_name
    FROM pg_constraint con
    JOIN pg_class      rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'tenant_integrations'
     AND con.contype = 'u'
     AND pg_get_constraintdef(con.oid) ILIKE '%(user_id, key)%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.tenant_integrations DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

-- Drop any auto-generated unique index too (defensive).
DROP INDEX IF EXISTS public.tenant_integrations_user_id_key_key;

-- ── 5. Add the new (tenant_id, key) unique constraint ────────────────────
DO $$
BEGIN
  ALTER TABLE public.tenant_integrations
    ADD CONSTRAINT tenant_integrations_tenant_key_uq UNIQUE (tenant_id, key);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 6. Lock down tenant_id ───────────────────────────────────────────────
ALTER TABLE public.tenant_integrations ALTER COLUMN tenant_id SET NOT NULL;

COMMENT ON CONSTRAINT tenant_integrations_tenant_key_uq ON public.tenant_integrations IS
  'Integrations are tenant-owned, not user-owned. Replaces (user_id, key) per migration 049.';

COMMIT;
