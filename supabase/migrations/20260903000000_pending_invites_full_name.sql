-- 20260903000000_pending_invites_full_name
-- Store the inviter-typed name of the invitee as a first-class column instead of
-- piggybacking it on `message`. Closes the `ponytail:` shortcut in
-- src/components/settings/RoleInviteModal.tsx — the accept form can now pre-fill
-- Name from the inviter's own input, ahead of Google metadata or the email
-- localpart, so the invitee sees "Hi, Priya Patel" instead of "hi priya patel".
--
-- Additive-only: nullable text column, no backfill needed. Existing rows
-- (invites already in flight) keep `full_name` NULL and the server continues to
-- honour `message` as a fallback — see the /api/team/invite handlers.
alter table public.pending_invites
  add column if not exists full_name text;

comment on column public.pending_invites.full_name is
  'Inviter-typed name of the invitee (optional). Pre-fills the Name field on the accept page. Falls back to auth metadata + email-localpart when null.';
