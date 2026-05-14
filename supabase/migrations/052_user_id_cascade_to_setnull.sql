-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 052 — relax ON DELETE CASCADE on tenant-scoped user_id FKs
--
-- Threat model: when a workspace member is deleted from auth.users (account
-- closure, GDPR purge, accidental admin DELETE), every workflow / contact /
-- broadcast / campaign / wa_template they ever created CASCADEs to oblivion
-- — taking the rest of the tenant's data with it. The tenant_id column on
-- each of these tables already preserves data ownership at the workspace
-- level, so the user_id FK should NULL out (audit-trail loss only) instead
-- of cascading to row deletion.
--
-- Threat model trace:
--   tenant T has user A (creator of workflow W) and user B.
--   A's auth.users row is deleted (employee departure, GDPR).
--   Old:  W.user_id CASCADE → W is deleted → tenant loses production workflow.
--   New:  W.user_id SET NULL → W stays, B continues to operate it. Tenant keeps data.
--
-- We discover the FK constraint name dynamically because the original CREATE
-- TABLE in 001 used the implicit `<table>_user_id_fkey` naming, but some
-- environments may have re-created with custom names.
--
-- Idempotent. Uses a helper function that recreates the FK with SET NULL
-- only if the current state is CASCADE.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Helper: relax a single user_id → auth.users CASCADE FK to SET NULL ──
DO $$
DECLARE
  rec RECORD;
  cn  text;
  target_tables text[] := ARRAY['workflows','contacts','broadcasts','campaigns','wa_templates'];
  t   text;
BEGIN
  FOREACH t IN ARRAY target_tables LOOP
    -- 1. ensure the user_id column is nullable (was NOT NULL in 001).
    BEGIN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id DROP NOT NULL', t);
    EXCEPTION WHEN others THEN NULL;
    END;

    -- 2. find the current FK on user_id pointing at auth.users
    FOR rec IN
      SELECT con.conname, con.confdeltype
        FROM pg_constraint con
        JOIN pg_class      rel  ON rel.oid  = con.conrelid
        JOIN pg_namespace  nsp  ON nsp.oid  = rel.relnamespace
        JOIN pg_class      frel ON frel.oid = con.confrelid
        JOIN pg_namespace  fnsp ON fnsp.oid = frel.relnamespace
       WHERE nsp.nspname  = 'public'
         AND rel.relname  = t
         AND con.contype  = 'f'
         AND fnsp.nspname = 'auth'
         AND frel.relname = 'users'
         AND EXISTS (
           SELECT 1
             FROM unnest(con.conkey) AS k
             JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum = k
            WHERE a.attname = 'user_id'
         )
    LOOP
      -- Only rebuild if currently CASCADE ('c'). 'n' = SET NULL (already correct).
      IF rec.confdeltype = 'c' THEN
        cn := rec.conname;
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, cn);
        EXECUTE format(
          'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL',
          t, cn
        );
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMENT ON COLUMN public.workflows.user_id    IS 'Creator audit ref. NULL after creator account deletion (FK SET NULL per migration 052).';
COMMENT ON COLUMN public.contacts.user_id     IS 'Creator audit ref. NULL after creator account deletion (FK SET NULL per migration 052).';
COMMENT ON COLUMN public.broadcasts.user_id   IS 'Creator audit ref. NULL after creator account deletion (FK SET NULL per migration 052).';
COMMENT ON COLUMN public.campaigns.user_id    IS 'Creator audit ref. NULL after creator account deletion (FK SET NULL per migration 052).';
COMMENT ON COLUMN public.wa_templates.user_id IS 'Creator audit ref. NULL after creator account deletion (FK SET NULL per migration 052).';

COMMIT;
