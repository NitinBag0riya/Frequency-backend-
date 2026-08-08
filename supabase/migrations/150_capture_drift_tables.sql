-- 150_capture_drift_tables.sql — tables that lived only on prod (ad-hoc SQL), now captured

create table if not exists public."tenant_branding" (
  "tenant_id" uuid not null,
  "display_name" text,
  "logo_url" text,
  "favicon_url" text,
  "accent_color" text not null default '#E08A2B'::text,
  "accent_on_dark" text,
  "hero_image_url" text,
  "base_theme" text not null default 'warm'::text,
  "tagline" text,
  "address" text,
  "support_phone" text,
  "terms_url" text,
  "privacy_url" text,
  "updated_at" timestamptz not null default now(),
  "secondary_color" text,
  "text_color" text,
  "selection_color" text,
  primary key ("tenant_id")
);

create table if not exists public."tenant_domains" (
  "id" uuid not null default gen_random_uuid(),
  "tenant_id" uuid not null,
  "hostname" text not null,
  "kind" text not null default 'custom'::text,
  "is_primary" bool not null default false,
  "verified" bool not null default false,
  "verification_token" text,
  "ssl_status" text not null default 'pending'::text,
  "created_at" timestamptz not null default now(),
  primary key ("id")
);

create table if not exists public."storefront_state" (
  "id" text not null,
  "data" jsonb not null,
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);

create table if not exists public."orders" (
  "id" text not null,
  "tenant_id" uuid,
  "slug" text,
  "source" text,
  "outlet_id" text,
  "table_no" int4,
  "mode" text,
  "guest_key" text,
  "guest_name" text,
  "guest_phone" text,
  "status" text,
  "payment_method" text,
  "pos_payment" text,
  "item_total" numeric,
  "tax" numeric,
  "service_charge" numeric,
  "discount" numeric,
  "grand" numeric,
  "coins_earned" numeric,
  "bill_no" int4,
  "kot_no" int4,
  "note" text,
  "due_cleared_at" timestamptz,
  "paid_at" timestamptz,
  "accepted_at" timestamptz,
  "created_at" timestamptz,
  "raw" jsonb,
  "synced_at" timestamptz not null default now(),
  primary key ("id")
);

create table if not exists public."order_lines" (
  "id" text not null,
  "order_id" text,
  "tenant_id" uuid,
  "name" text,
  "qty" int4,
  "price" numeric,
  "veg" bool,
  "options" jsonb,
  primary key ("id")
);

create table if not exists public."order_tenders" (
  "id" text not null,
  "order_id" text,
  "tenant_id" uuid,
  "mode" text,
  "amount" numeric,
  "reason" text,
  "reverses_id" text,
  "at" timestamptz,
  primary key ("id")
);

create table if not exists public."menu_channel_map" (
  "id" uuid not null default gen_random_uuid(),
  "tenant_id" uuid not null,
  "master_key" text not null,
  "master_name" text,
  "channel" text not null,
  "outlet_ref" text,
  "channel_item_id" text,
  "channel_name" text,
  "channel_price" numeric,
  "available" bool not null default true,
  "match_type" text not null default 'auto'::text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);

create table if not exists public."guest_sessions" (
  "id" uuid not null default gen_random_uuid(),
  "tenant_id" uuid not null,
  "phone" text not null,
  "contact_id" uuid,
  "created_at" timestamptz not null default now(),
  "last_seen_at" timestamptz,
  primary key ("id")
);

create table if not exists public."invitation_codes" (
  "id" uuid not null default gen_random_uuid(),
  "code" text not null,
  "email" text not null,
  "phone" text,
  "status" text not null default 'unused'::text,
  "request_id" uuid,
  "notes" text,
  "expires_at" timestamptz,
  "sent_at" timestamptz,
  "used_at" timestamptz,
  "used_by" uuid,
  "created_at" timestamptz not null default now(),
  "created_by" uuid,
  primary key ("id")
);

create table if not exists public."access_requests" (
  "id" uuid not null default gen_random_uuid(),
  "email" text not null,
  "phone" text not null,
  "name" text,
  "company" text,
  "use_case" text,
  "status" text not null default 'pending'::text,
  "invitation_code_id" uuid,
  "source" text,
  "ip_hash" text,
  "created_at" timestamptz not null default now(),
  "reviewed_at" timestamptz,
  "reviewed_by" uuid,
  "notes" text,
  primary key ("id")
);

create table if not exists public."aggregator_menu_actions" (
  "id" uuid not null default gen_random_uuid(),
  "tenant_id" uuid not null,
  "source" text not null default 'frequency_desktop'::text,
  "channel" text not null,
  "outlet_ref" text,
  "action" text not null default 'edit'::text,
  "entity_id" text,
  "item_vo" jsonb not null,
  "status" text not null default 'pending'::text,
  "result" jsonb,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);

create table if not exists public."storefront_app_builds" (
  "id" uuid not null default gen_random_uuid(),
  "tenant_id" uuid not null,
  "platform" text not null,
  "version" text,
  "status" text not null default 'queued'::text,
  "store_url" text,
  "error" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "eas_build_id" text,
  "profile" text,
  primary key ("id")
);

create table if not exists public."storefront_app_credentials" (
  "id" uuid not null default gen_random_uuid(),
  "tenant_id" uuid not null,
  "platform" text not null,
  "enc" text not null,
  "status" text not null default 'connected'::text,
  "meta" jsonb not null default '{}'::jsonb,
  "connected_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);
