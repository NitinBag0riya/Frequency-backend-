-- Relax constraints on tenants table to allow creating a tenant record before WhatsApp is connected.
ALTER TABLE public.tenants ALTER COLUMN waba_id DROP NOT NULL;
ALTER TABLE public.tenants ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE public.tenants ALTER COLUMN access_token DROP NOT NULL;
