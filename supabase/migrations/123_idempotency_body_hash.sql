-- P1: idempotency key includes body hash.
--
-- Without a body hash, a buggy client that reuses the same
-- Idempotency-Key across DISTINCT payloads gets the cached response
-- from the first call replayed for every subsequent send — the second
-- through Nth real messages never go to Meta and the operator gets a
-- silent 200. (Stripe documents the same gotcha; their fix is a 409
-- when key+endpoint matches but body differs.)
--
-- We add a nullable body_hash column. Existing rows have NULL — those
-- continue to behave as before. New rows store sha256(canonical body)
-- and the lookup path branches: same key+endpoint+hash → replay;
-- same key+endpoint but DIFFERENT hash → 409 (mismatched body).

alter table public.idempotency_keys
  add column if not exists body_hash text;

-- Pairs (tenant, key, endpoint, body_hash) should be unique so we can
-- accept identical retries (same body) but reject mismatches at the
-- DB level as a backstop to the app-layer 409. We keep the original
-- PK (tenant, key, endpoint) intact so legacy callers (NULL hash)
-- can't collide either.
create index if not exists idempotency_keys_lookup
  on public.idempotency_keys (tenant_id, key, endpoint);
