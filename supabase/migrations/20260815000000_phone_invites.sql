-- Phone-number team invites (additive, backward-compatible).
--
-- Adds an optional `phone` (E.164) to pending_invites so a tenant admin can
-- invite staff by mobile number and deliver the join link over WhatsApp,
-- alongside the existing email invites. Email is loosened to nullable because a
-- phone invite has no email until the invitee chooses one (or none) at join.
--
-- Nothing here removes or narrows the existing email flow: existing rows keep
-- their email, the email uniqueness index is untouched, and a new CHECK simply
-- requires at least one contact channel per row.

alter table public.pending_invites add column if not exists phone text;

-- Was NOT NULL — phone invites carry phone instead of email.
alter table public.pending_invites alter column email drop not null;

-- Every invite must still be reachable by at least one channel.
alter table public.pending_invites drop constraint if exists pending_invites_channel_present;
alter table public.pending_invites add constraint pending_invites_channel_present
  check (email is not null or phone is not null);

-- Mirror the email active-uniqueness guard for phone, so re-inviting the same
-- number while one is still pending 409s instead of stacking duplicates.
create unique index if not exists invites_active_phone_unique
  on public.pending_invites(tenant_id, phone) where status = 'pending' and phone is not null;
