-- Targeted compatibility migration for reported admin API schema gaps.
-- Apply only after the organization/RBAC prerequisites, including migrations 956 and 968.
-- This is intentionally narrow; it does not replay the full RBAC migration chain.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.staff') IS NULL
     OR to_regclass('public.approval_requests') IS NULL
     OR to_regclass('public.organizations') IS NULL
     OR to_regprocedure('public.current_organization_id()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xhaira_runtime') THEN
    RAISE EXCEPTION 'Required tenant, staff, approval, or runtime-role prerequisites are missing';
  END IF;

  IF to_regclass('public.uq_users_id_organization') IS NULL THEN
    RAISE EXCEPTION 'Missing users(id, organization_id) unique index; apply the approved tenant schema migration first';
  END IF;

  IF to_regclass('public.rbac_audit_logs') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'rbac_audit_logs'
          AND column_name = 'organization_id'
     ) THEN
    RAISE EXCEPTION 'rbac_audit_logs exists without organization_id; refusing to expose or guess ownership of existing audit rows';
  END IF;
END $$;

-- Legacy staff tables may lack these compatibility fields. Existing staff rows
-- receive the historical schema default status of active.
ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'active';
ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS linked_user_id UUID;

-- Backfill links only when the staff and user rows belong to the same organization.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'user_id'
  ) THEN
    UPDATE public.staff s
       SET linked_user_id = u.id
      FROM public.users u
     WHERE u.id = s.user_id
       AND u.organization_id = s.organization_id
       AND s.linked_user_id IS NULL;
  END IF;

  UPDATE public.staff s
     SET linked_user_id = u.id
    FROM public.users u
   WHERE u.staff_id = s.id
     AND u.organization_id = s.organization_id
     AND s.linked_user_id IS NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.staff'::regclass
       AND conname = 'staff_linked_user_same_organization_fkey'
  ) THEN
    ALTER TABLE public.staff
      ADD CONSTRAINT staff_linked_user_same_organization_fkey
      FOREIGN KEY (linked_user_id, organization_id)
      REFERENCES public.users(id, organization_id)
      NOT VALID;
  END IF;
END $$;
ALTER TABLE public.staff
  VALIDATE CONSTRAINT staff_linked_user_same_organization_fkey;
CREATE INDEX IF NOT EXISTS idx_staff_organization_linked_user
  ON public.staff (organization_id, linked_user_id);

-- Add the approval actor field missing from the deployed approval_requests table.
ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS approver_user_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.approval_requests'::regclass
       AND conname = 'approval_requests_approver_user_fkey'
  ) THEN
    ALTER TABLE public.approval_requests
      ADD CONSTRAINT approval_requests_approver_user_fkey
      FOREIGN KEY (approver_user_id)
      REFERENCES public.users(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;
ALTER TABLE public.approval_requests
  VALIDATE CONSTRAINT approval_requests_approver_user_fkey;
CREATE INDEX IF NOT EXISTS idx_approval_requests_approver_user
  ON public.approval_requests (approver_user_id);

-- Create organization-scoped RBAC audit storage. If an older global table exists,
-- the preflight above aborts instead of assigning its rows to a tenant by guess.
CREATE TABLE IF NOT EXISTS public.rbac_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  user_id UUID,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100),
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rbac_audit_logs_user_same_organization_fkey
    FOREIGN KEY (user_id, organization_id)
    REFERENCES public.users(id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_rbac_audit_logs_organization_created
  ON public.rbac_audit_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rbac_audit_logs_organization_action
  ON public.rbac_audit_logs (organization_id, action);

ALTER TABLE public.rbac_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rbac_audit_logs FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'rbac_audit_logs'
       AND policyname = 'rbac_audit_logs_organization_scope'
  ) THEN
    CREATE POLICY rbac_audit_logs_organization_scope
      ON public.rbac_audit_logs
      FOR ALL TO xhaira_runtime
      USING (organization_id = public.current_organization_id())
      WITH CHECK (organization_id = public.current_organization_id());
  END IF;
END $$;

GRANT SELECT, INSERT ON public.rbac_audit_logs TO xhaira_runtime;

COMMIT;
