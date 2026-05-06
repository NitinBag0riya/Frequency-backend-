-- Add tenant_id to tables that are scoped to tenants but were missing the column
-- (campaigns was created in 001 without tenant_id; 007's CREATE IF NOT EXISTS skipped it)

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;

-- Performance indexes
CREATE INDEX IF NOT EXISTS contacts_tenant_id   ON public.contacts(tenant_id);
CREATE INDEX IF NOT EXISTS broadcasts_tenant_id ON public.broadcasts(tenant_id);
CREATE INDEX IF NOT EXISTS workflows_tenant_id  ON public.workflows(tenant_id);
CREATE INDEX IF NOT EXISTS campaigns_tenant_id  ON public.campaigns(tenant_id);

-- Back-fill existing rows: link to the tenant owned by the same user
UPDATE public.contacts c
SET tenant_id = (
  SELECT t.id FROM public.tenants t
  WHERE t.user_id = c.user_id AND t.status = 'active'
  ORDER BY t.created_at LIMIT 1
)
WHERE c.tenant_id IS NULL;

UPDATE public.broadcasts b
SET tenant_id = (
  SELECT t.id FROM public.tenants t
  WHERE t.user_id = b.user_id AND t.status = 'active'
  ORDER BY t.created_at LIMIT 1
)
WHERE b.tenant_id IS NULL;

UPDATE public.workflows w
SET tenant_id = (
  SELECT t.id FROM public.tenants t
  WHERE t.user_id = w.user_id AND t.status = 'active'
  ORDER BY t.created_at LIMIT 1
)
WHERE w.tenant_id IS NULL;

UPDATE public.campaigns c
SET tenant_id = (
  SELECT t.id FROM public.tenants t
  WHERE t.user_id = c.user_id AND t.status = 'active'
  ORDER BY t.created_at LIMIT 1
)
WHERE c.tenant_id IS NULL;

-- Seed missing role_permissions features that checkPermission uses
-- (007 only seeded contacts/broadcasts/workflows; the API uses leads/whatsapp_automation/integrations)
INSERT INTO public.role_permissions (tenant_id, role, feature, can_view, can_edit, can_delete) VALUES
  (NULL, 'admin',  'whatsapp_automation', true,  true,  true),
  (NULL, 'admin',  'leads',               true,  true,  true),
  (NULL, 'admin',  'integrations',        true,  true,  true),
  (NULL, 'admin',  'google_sheets',       true,  true,  false),
  (NULL, 'agent',  'whatsapp_automation', true,  false, false),
  (NULL, 'agent',  'leads',               true,  true,  false),
  (NULL, 'agent',  'integrations',        true,  false, false),
  (NULL, 'agent',  'google_sheets',       true,  false, false),
  (NULL, 'viewer', 'whatsapp_automation', true,  false, false),
  (NULL, 'viewer', 'leads',               true,  false, false),
  (NULL, 'viewer', 'integrations',        false, false, false),
  (NULL, 'viewer', 'google_sheets',       false, false, false)
ON CONFLICT DO NOTHING;

-- Seed user_roles for existing tenant owners (admin role) so identifyTenant works
INSERT INTO public.user_roles (user_id, tenant_id, role)
SELECT DISTINCT t.user_id, t.id, 'admin'
FROM public.tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles r
  WHERE r.user_id = t.user_id AND r.tenant_id = t.id
)
ON CONFLICT DO NOTHING;
