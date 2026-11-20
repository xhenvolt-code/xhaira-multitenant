-- Migration 968: restore the tenant-scoped department schema and staff display name.
-- Apply after 956_organization_multitenancy.sql and corrected 967_organization_scoped_rbac.sql.
-- This migration creates missing empty department tables; it does not recreate lost department data.
-- It aborts rather than guessing an organization for any pre-existing incomplete department table.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.staff') IS NULL
     OR to_regclass('public.roles') IS NULL
     OR to_regprocedure('public.current_organization_id()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xhaira_runtime') THEN
    RAISE EXCEPTION 'Prerequisite tenant tables/functions are missing; apply the approved organization and RBAC migrations first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'organization_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'organization_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'organization_id') THEN
    RAISE EXCEPTION 'Tenant organization_id columns are missing; refusing to guess tenant assignments';
  END IF;
END $$;

-- Older checked-in staff schemas use full_name. Current RBAC writes expect name.
ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS name VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_id_organization
  ON public.users (id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_id_organization
  ON public.roles (id, organization_id);

CREATE TABLE IF NOT EXISTS public.departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_name VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  description TEXT,
  alias VARCHAR(100),
  parent_department_id UUID,
  head_user_id UUID,
  color VARCHAR(20) DEFAULT '#3b82f6',
  icon VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT true,
  deleted_reason TEXT,
  deactivated_at TIMESTAMPTZ,
  deactivated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  CONSTRAINT departments_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT departments_parent_same_organization_fkey
    FOREIGN KEY (parent_department_id, organization_id)
    REFERENCES public.departments(id, organization_id),
  CONSTRAINT departments_head_same_organization_fkey
    FOREIGN KEY (head_user_id, organization_id)
    REFERENCES public.users(id, organization_id)
);

ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS department_name VARCHAR(255);
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS alias VARCHAR(100);
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS parent_department_id UUID;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS head_user_id UUID;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT '#3b82f6';
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS icon VARCHAR(50);
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS deleted_reason TEXT;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS deactivated_by UUID;
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'departments' AND column_name = 'organization_id'
  ) THEN
    RAISE EXCEPTION 'Existing departments table has no organization_id; assign tenants from verified records before continuing';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS departments_id_organization_key
  ON public.departments (id, organization_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.departments WHERE organization_id IS NULL) THEN
    RAISE EXCEPTION 'departments contains rows without organization_id; refusing to assign tenant ownership';
  END IF;
  ALTER TABLE public.departments ALTER COLUMN organization_id SET NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.departments'::regclass AND conname = 'departments_parent_same_organization_fkey') THEN
    ALTER TABLE public.departments
      ADD CONSTRAINT departments_parent_same_organization_fkey
      FOREIGN KEY (parent_department_id, organization_id)
      REFERENCES public.departments(id, organization_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.departments'::regclass AND conname = 'departments_head_same_organization_fkey') THEN
    ALTER TABLE public.departments
      ADD CONSTRAINT departments_head_same_organization_fkey
      FOREIGN KEY (head_user_id, organization_id)
      REFERENCES public.users(id, organization_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_organization_display_name
  ON public.departments (organization_id, (COALESCE(name, department_name)));
CREATE INDEX IF NOT EXISTS idx_departments_organization_active
  ON public.departments (organization_id, is_active);

CREATE TABLE IF NOT EXISTS public.department_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL,
  role_id UUID NOT NULL,
  is_lead BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  CONSTRAINT department_roles_department_org_fkey
    FOREIGN KEY (department_id, organization_id)
    REFERENCES public.departments(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT department_roles_role_org_fkey
    FOREIGN KEY (role_id, organization_id)
    REFERENCES public.roles(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT department_roles_department_role_key UNIQUE (department_id, role_id)
);

CREATE TABLE IF NOT EXISTS public.department_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  content TEXT,
  document_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  CONSTRAINT department_policies_department_org_fkey
    FOREIGN KEY (department_id, organization_id)
    REFERENCES public.departments(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.department_kpis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  target_value NUMERIC(15,2),
  current_value NUMERIC(15,2) DEFAULT 0,
  unit VARCHAR(50),
  period VARCHAR(20) DEFAULT 'monthly',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  CONSTRAINT department_kpis_department_org_fkey
    FOREIGN KEY (department_id, organization_id)
    REFERENCES public.departments(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.department_processes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'draft', 'archived')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  CONSTRAINT department_processes_department_org_fkey
    FOREIGN KEY (department_id, organization_id)
    REFERENCES public.departments(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.department_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL,
  media_id UUID,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  document_url TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  CONSTRAINT department_documents_department_org_fkey
    FOREIGN KEY (department_id, organization_id)
    REFERENCES public.departments(id, organization_id) ON DELETE CASCADE
);

DO $$
DECLARE
  v_table_name TEXT;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'departments', 'department_roles', 'department_policies', 'department_kpis',
    'department_processes', 'department_documents'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND information_schema.columns.table_name = v_table_name
         AND column_name = 'organization_id'
    ) THEN
      RAISE EXCEPTION 'public.% has no organization_id; refusing to infer tenant ownership', v_table_name;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table_name);
    EXECUTE format('DROP POLICY IF EXISTS organization_isolation ON public.%I', v_table_name);
    EXECUTE format(
      'CREATE POLICY organization_isolation ON public.%I USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id())',
      v_table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS organization_scope_guard ON public.%I', v_table_name);
    EXECUTE format(
      'CREATE POLICY organization_scope_guard ON public.%I AS RESTRICTIVE USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id())',
      v_table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO xhaira_runtime', v_table_name);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_department_roles_organization_department
  ON public.department_roles (organization_id, department_id);
CREATE INDEX IF NOT EXISTS idx_department_policies_organization_department
  ON public.department_policies (organization_id, department_id);
CREATE INDEX IF NOT EXISTS idx_department_kpis_organization_department
  ON public.department_kpis (organization_id, department_id);
CREATE INDEX IF NOT EXISTS idx_department_processes_organization_department
  ON public.department_processes (organization_id, department_id);
CREATE INDEX IF NOT EXISTS idx_department_documents_organization_department
  ON public.department_documents (organization_id, department_id);

COMMIT;
