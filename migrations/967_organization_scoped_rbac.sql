-- Migration 967: organization-scoped roles and role permissions.
-- Apply once during a maintenance window: cloning/remapping role references
-- takes ACCESS EXCLUSIVE locks on roles and row locks on referencing tables.
-- This does not modify user balances, ledger rows, or payment records.
-- Forward recovery: the DDL and data copy are transactional; if execution fails,
-- resolve the reported schema/data conflict and rerun the complete file.

BEGIN;

CREATE TABLE IF NOT EXISTS public.roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS organization_id UUID,
  ADD COLUMN IF NOT EXISTS hierarchy_level INTEGER DEFAULT 5,
  ADD COLUMN IF NOT EXISTS authority_level INTEGER DEFAULT 20,
  ADD COLUMN IF NOT EXISTS department_id UUID,
  ADD COLUMN IF NOT EXISTS alias VARCHAR(100),
  ADD COLUMN IF NOT EXISTS responsibilities TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS data_scope VARCHAR(20) NOT NULL DEFAULT 'OWN';

CREATE TABLE IF NOT EXISTS public.permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.permissions
  ADD COLUMN IF NOT EXISTS name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS route_path VARCHAR(255),
  ADD COLUMN IF NOT EXISTS method VARCHAR(10);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.role_permissions
  ADD COLUMN IF NOT EXISTS organization_id UUID;

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.roles'::regclass
       AND c.contype = 'u'
       AND c.conkey = ARRAY[
         (SELECT a.attnum
            FROM pg_attribute a
           WHERE a.attrelid = 'public.roles'::regclass
             AND a.attname = 'name')
       ]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE public.roles DROP CONSTRAINT %I', item.conname);
  END LOOP;

  FOR item IN
    SELECT ns.nspname, idx.relname
      FROM pg_index i
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      JOIN pg_class idx ON idx.oid = i.indexrelid
     WHERE tbl.oid = 'public.roles'::regclass
       AND i.indisunique
       AND NOT i.indisprimary
       AND i.indnkeyatts = 1
       AND i.indkey[0] = (
         SELECT a.attnum FROM pg_attribute a
          WHERE a.attrelid = 'public.roles'::regclass AND a.attname = 'name'
       )
  LOOP
    EXECUTE format('DROP INDEX %I.%I', item.nspname, item.relname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_global_name
  ON public.roles (name) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_organization_name
  ON public.roles (organization_id, name) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_id_organization
  ON public.roles (id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_permissions_module_action
  ON public.permissions (module, action);
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_permissions_role_permission
  ON public.role_permissions (role_id, permission_id);

CREATE TEMP TABLE rbac_rls_state (
  schema_name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  was_enabled BOOLEAN NOT NULL,
  was_forced BOOLEAN NOT NULL,
  PRIMARY KEY (schema_name, table_name)
) ON COMMIT DROP;

DO $$
DECLARE
  item RECORD;
BEGIN
  INSERT INTO rbac_rls_state (schema_name, table_name, was_enabled, was_forced)
  SELECT DISTINCT ns.nspname, tbl.relname, tbl.relrowsecurity, tbl.relforcerowsecurity
    FROM pg_class tbl
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
   WHERE ns.nspname = 'public'
     AND tbl.relkind IN ('r', 'p')
     AND tbl.relrowsecurity
     AND (
       tbl.oid IN ('public.roles'::regclass, 'public.role_permissions'::regclass)
       OR EXISTS (
         SELECT 1
           FROM pg_constraint fk
          WHERE fk.contype = 'f'
            AND fk.conrelid = tbl.oid
            AND fk.confrelid = 'public.roles'::regclass
       )
     )
  ON CONFLICT DO NOTHING;

  FOR item IN SELECT schema_name, table_name FROM rbac_rls_state LOOP
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', item.schema_name, item.table_name);
  END LOOP;
END $$;

INSERT INTO public.permissions (module, action, description)
VALUES
  ('dashboard', 'view', 'View the main dashboard'),
  ('users', 'view', 'View user accounts'),
  ('users', 'create', 'Create user accounts'),
  ('users', 'update', 'Update user accounts'),
  ('users', 'delete', 'Delete user accounts'),
  ('staff', 'view', 'View staff'),
  ('staff', 'create', 'Create staff'),
  ('staff', 'update', 'Update staff'),
  ('staff', 'delete', 'Delete staff'),
  ('roles', 'manage', 'Manage organization roles and their permissions'),
  ('finance', 'view', 'View financial records'),
  ('finance', 'create', 'Create financial transactions'),
  ('finance', 'manage', 'Manage finance'),
  ('accounts', 'view', 'View accounts'),
  ('accounts', 'create', 'Create accounts'),
  ('accounts', 'update', 'Update accounts'),
  ('accounts', 'delete', 'Delete accounts'),
  ('reports', 'view', 'View reports'),
  ('reports', 'export', 'Export reports'),
  ('settings', 'view', 'View settings'),
  ('settings', 'manage', 'Manage organization settings'),
  ('departments', 'view', 'View departments'),
  ('departments', 'manage', 'Manage departments'),
  ('approvals', 'view', 'View approval requests'),
  ('approvals', 'manage', 'Manage approval requests')
ON CONFLICT (module, action) DO NOTHING;

UPDATE public.permissions
   SET name = COALESCE(name, module || '_' || action)
 WHERE name IS NULL;

INSERT INTO public.roles (name, description, is_system, hierarchy_level, authority_level, is_active, data_scope)
SELECT seed.name, seed.description, true, seed.hierarchy_level, seed.authority_level, true, 'GLOBAL'
  FROM (VALUES
    ('superadmin', 'Organization owner; unrestricted organization access', 1, 100),
    ('admin', 'Organization administrator', 2, 80),
    ('staff', 'Standard organization staff', 5, 20),
    ('user', 'Standard organization user', 6, 10),
    ('viewer', 'Read-only organization access', 8, 5)
  ) AS seed(name, description, hierarchy_level, authority_level)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.roles r
    WHERE r.organization_id IS NULL AND r.name = seed.name
 );

CREATE TEMP TABLE rbac_role_id_map (
  organization_id UUID NOT NULL,
  old_role_id UUID NOT NULL,
  new_role_id UUID NOT NULL,
  PRIMARY KEY (organization_id, old_role_id)
) ON COMMIT DROP;

DO $$
DECLARE
  org RECORD;
  legacy_role RECORD;
  cloned_role_id UUID;
BEGIN
  FOR org IN SELECT id FROM public.organizations LOOP
    FOR legacy_role IN
      SELECT * FROM public.roles WHERE organization_id IS NULL
    LOOP
      SELECT id INTO cloned_role_id
        FROM public.roles
       WHERE organization_id = org.id AND name = legacy_role.name;

      IF cloned_role_id IS NULL THEN
        cloned_role_id := gen_random_uuid();
        INSERT INTO public.roles
        SELECT (jsonb_populate_record(
          NULL::public.roles,
          to_jsonb(legacy_role) || jsonb_build_object(
            'id', cloned_role_id,
            'organization_id', org.id
          )
        )).*;
      END IF;

      INSERT INTO rbac_role_id_map (organization_id, old_role_id, new_role_id)
      VALUES (org.id, legacy_role.id, cloned_role_id)
      ON CONFLICT (organization_id, old_role_id)
      DO UPDATE SET new_role_id = EXCLUDED.new_role_id;
    END LOOP;
  END LOOP;
END $$;

INSERT INTO public.role_permissions (role_id, permission_id, organization_id)
SELECT map.new_role_id, legacy.permission_id, map.organization_id
  FROM rbac_role_id_map map
  JOIN public.role_permissions legacy ON legacy.role_id = map.old_role_id
ON CONFLICT (role_id, permission_id) DO NOTHING;

DELETE FROM public.role_permissions rp
 USING public.roles r
 WHERE rp.role_id = r.id
   AND r.organization_id IS NULL;

DO $$
DECLARE
  ref RECORD;
BEGIN
  FOR ref IN
    SELECT DISTINCT
           child_ns.nspname AS schema_name,
           child.relname AS table_name,
           child_col.attname AS role_column
      FROM pg_constraint fk
      JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = fk.confrelid
      JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY AS key_col(attnum, ord) ON true
      JOIN LATERAL unnest(fk.confkey) WITH ORDINALITY AS ref_col(attnum, ord) ON ref_col.ord = key_col.ord
      JOIN pg_attribute child_col ON child_col.attrelid = child.oid AND child_col.attnum = key_col.attnum
      JOIN pg_attribute parent_col ON parent_col.attrelid = parent.oid AND parent_col.attnum = ref_col.attnum
      JOIN pg_attribute org_col ON org_col.attrelid = child.oid AND org_col.attname = 'organization_id' AND NOT org_col.attisdropped
     WHERE fk.contype = 'f'
       AND parent.oid = 'public.roles'::regclass
       AND parent_col.attname = 'id'
       AND child.oid <> 'public.role_permissions'::regclass
       AND child_ns.nspname = 'public'
  LOOP
    EXECUTE format(
      'UPDATE %I.%I child SET %I = map.new_role_id
        FROM rbac_role_id_map map
       WHERE child.organization_id = map.organization_id
         AND child.%I = map.old_role_id',
      ref.schema_name, ref.table_name, ref.role_column, ref.role_column
    );
  END LOOP;
END $$;

UPDATE public.roles r
   SET hierarchy_level = seed.hierarchy_level,
       authority_level = seed.authority_level,
       is_active = true
  FROM (VALUES
    ('superadmin', 1, 100),
    ('admin', 2, 80),
    ('staff', 5, 20),
    ('user', 6, 10),
    ('viewer', 8, 5)
  ) AS seed(name, hierarchy_level, authority_level)
 WHERE r.organization_id IS NOT NULL
   AND r.name = seed.name
   AND r.is_system = true;

INSERT INTO public.role_permissions (role_id, permission_id, organization_id)
SELECT r.id, p.id, r.organization_id
  FROM public.roles r
  CROSS JOIN public.permissions p
 WHERE r.organization_id IS NOT NULL
   AND r.name = 'superadmin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id, organization_id)
SELECT r.id, p.id, r.organization_id
  FROM public.roles r
  CROSS JOIN public.permissions p
 WHERE r.organization_id IS NOT NULL
   AND r.name = 'admin'
   AND (
     (p.module IN ('dashboard', 'accounts', 'finance', 'settings') AND p.action = 'view')
     OR (p.module = 'users' AND p.action IN ('view', 'create', 'update'))
     OR (p.module = 'staff' AND p.action IN ('view', 'create', 'update'))
     OR (p.module = 'departments' AND p.action IN ('view', 'manage'))
     OR (p.module = 'reports' AND p.action IN ('view', 'export'))
   )
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id, organization_id)
SELECT r.id, p.id, r.organization_id
  FROM public.roles r
  CROSS JOIN public.permissions p
 WHERE r.organization_id IS NOT NULL
   AND r.name = 'viewer'
   AND p.action = 'view'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id, organization_id)
SELECT r.id, p.id, r.organization_id
  FROM public.roles r
  CROSS JOIN public.permissions p
 WHERE r.organization_id IS NOT NULL
   AND r.name IN ('staff', 'user')
   AND p.action = 'view'
   AND p.module IN ('dashboard', 'staff', 'finance', 'accounts', 'reports')
ON CONFLICT (role_id, permission_id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.roles'::regclass
       AND conname = 'roles_organization_id_fkey'
  ) THEN
    ALTER TABLE public.roles
      ADD CONSTRAINT roles_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.role_permissions'::regclass
       AND conname = 'role_permissions_organization_id_fkey'
  ) THEN
    ALTER TABLE public.role_permissions
      ADD CONSTRAINT role_permissions_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.role_permissions'::regclass
       AND conname = 'role_permissions_role_organization_fkey'
  ) THEN
    ALTER TABLE public.role_permissions
      ADD CONSTRAINT role_permissions_role_organization_fkey
      FOREIGN KEY (role_id, organization_id)
      REFERENCES public.roles(id, organization_id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE public.role_permissions
  ALTER COLUMN organization_id SET NOT NULL;

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN SELECT schema_name, table_name, was_enabled, was_forced FROM rbac_rls_state LOOP
    IF item.schema_name = 'public' AND item.table_name IN ('roles', 'role_permissions') THEN
      CONTINUE;
    END IF;
    IF item.was_enabled THEN
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', item.schema_name, item.table_name);
    END IF;
    IF item.was_forced THEN
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', item.schema_name, item.table_name);
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_roles_organization_id
  ON public.roles (organization_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_organization_id
  ON public.role_permissions (organization_id);

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_isolation ON public.roles;
CREATE POLICY organization_isolation ON public.roles
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

DROP POLICY IF EXISTS organization_isolation ON public.role_permissions;
CREATE POLICY organization_isolation ON public.role_permissions
  USING (organization_id = public.current_organization_id())
  WITH CHECK (organization_id = public.current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.roles TO xhaira_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO xhaira_runtime;
GRANT SELECT ON public.permissions TO xhaira_runtime;

COMMIT;
