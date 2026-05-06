-- Role-based access control
-- Roles: super_admin (platform), admin (tenant owner), agent, viewer

CREATE TABLE IF NOT EXISTS user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  tenant_id   uuid references tenants(id) on delete cascade,   -- null = super_admin (platform-wide)
  role        text not null check (role in ('super_admin', 'admin', 'agent', 'viewer')),
  invited_by  uuid references auth.users(id),
  created_at  timestamptz default now()
);

-- One role per user per scope (global or per tenant)
CREATE UNIQUE INDEX user_roles_unique_scope
  ON user_roles (user_id, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- Users can read their own roles; super_admins can read all
CREATE POLICY "self_read" ON user_roles FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM user_roles sr
      WHERE sr.user_id = auth.uid() AND sr.role = 'super_admin' AND sr.tenant_id IS NULL
    )
  );

-- Admins can insert roles for their tenant
CREATE POLICY "admin_insert" ON user_roles FOR INSERT WITH CHECK (
  -- super_admin can insert anything
  EXISTS (SELECT 1 FROM user_roles sr WHERE sr.user_id = auth.uid() AND sr.role = 'super_admin' AND sr.tenant_id IS NULL)
  OR
  -- tenant admin can invite to their own tenant
  (
    tenant_id IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM user_roles ar
      WHERE ar.user_id = auth.uid() AND ar.role IN ('super_admin','admin') AND ar.tenant_id = user_roles.tenant_id
    )
  )
);

CREATE POLICY "admin_delete" ON user_roles FOR DELETE USING (
  user_id = auth.uid()
  OR EXISTS (SELECT 1 FROM user_roles ar WHERE ar.user_id = auth.uid() AND ar.role IN ('super_admin','admin'))
);

-- Role feature permissions (tenant-overridable)
CREATE TABLE IF NOT EXISTS role_permissions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references tenants(id) on delete cascade,  -- null = default config
  role        text not null,
  feature     text not null,   -- inbox, broadcasts, templates, contacts, workflows, analytics, settings, billing
  can_view    boolean default true,
  can_edit    boolean default false,
  can_delete  boolean default false,
  updated_at  timestamptz default now()
);

CREATE UNIQUE INDEX role_permissions_unique
  ON role_permissions (coalesce(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid), role, feature);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_own" ON role_permissions FOR SELECT USING (
  tenant_id IS NULL OR
  EXISTS (SELECT 1 FROM tenants t WHERE t.id = role_permissions.tenant_id AND t.user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = auth.uid() AND r.tenant_id = role_permissions.tenant_id)
);
CREATE POLICY "admin_write" ON role_permissions FOR ALL USING (
  EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = auth.uid() AND r.role IN ('super_admin','admin'))
);

-- Seed default permissions
INSERT INTO role_permissions (tenant_id, role, feature, can_view, can_edit, can_delete) VALUES
  -- admin: full access to all features
  (NULL, 'admin',  'inbox',       true,  true,  true),
  (NULL, 'admin',  'broadcasts',  true,  true,  true),
  (NULL, 'admin',  'templates',   true,  true,  true),
  (NULL, 'admin',  'contacts',    true,  true,  true),
  (NULL, 'admin',  'workflows',   true,  true,  true),
  (NULL, 'admin',  'analytics',   true,  false, false),
  (NULL, 'admin',  'settings',    true,  true,  false),
  (NULL, 'admin',  'billing',     true,  true,  false),
  (NULL, 'admin',  'campaigns',   true,  true,  true),
  -- agent: operational access, no settings/billing
  (NULL, 'agent',  'inbox',       true,  true,  false),
  (NULL, 'agent',  'broadcasts',  true,  false, false),
  (NULL, 'agent',  'templates',   true,  false, false),
  (NULL, 'agent',  'contacts',    true,  true,  false),
  (NULL, 'agent',  'workflows',   true,  false, false),
  (NULL, 'agent',  'analytics',   true,  false, false),
  (NULL, 'agent',  'settings',    false, false, false),
  (NULL, 'agent',  'billing',     false, false, false),
  (NULL, 'agent',  'campaigns',   true,  false, false),
  -- viewer: read-only
  (NULL, 'viewer', 'inbox',       true,  false, false),
  (NULL, 'viewer', 'broadcasts',  true,  false, false),
  (NULL, 'viewer', 'templates',   true,  false, false),
  (NULL, 'viewer', 'contacts',    true,  false, false),
  (NULL, 'viewer', 'workflows',   true,  false, false),
  (NULL, 'viewer', 'analytics',   true,  false, false),
  (NULL, 'viewer', 'settings',    false, false, false),
  (NULL, 'viewer', 'billing',     false, false, false),
  (NULL, 'viewer', 'campaigns',   true,  false, false)
ON CONFLICT DO NOTHING;

-- Campaigns table (if not exists already)
CREATE TABLE IF NOT EXISTS campaigns (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  tenant_id   uuid references tenants(id) on delete cascade,
  name        text not null,
  description text,
  type        text default 'drip' check (type in ('drip','one_time','triggered')),
  status      text default 'draft' check (status in ('draft','active','paused','completed')),
  trigger     jsonb default '{}',
  steps       jsonb default '[]',
  stats       jsonb default '{"enrolled":0,"active":0,"converted":0,"revenue":0}',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_all" ON campaigns FOR ALL USING (user_id = auth.uid());
