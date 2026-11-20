-- Migration 970: add the organization-scoped staff department reference.
-- Apply after migration 968_department_schema_recovery.sql.
-- No existing department IDs are inferred or rewritten.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.staff') IS NULL OR to_regclass('public.departments') IS NULL THEN
    RAISE EXCEPTION 'public.staff and public.departments must exist before this migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'organization_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'departments' AND column_name = 'organization_id'
  ) THEN
    RAISE EXCEPTION 'Tenant organization_id columns are missing; refusing to infer department ownership';
  END IF;
END $$;

ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS department_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS departments_id_organization_key
  ON public.departments (id, organization_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.staff'::regclass
       AND conname = 'staff_department_same_organization_fkey'
  ) THEN
    ALTER TABLE public.staff
      ADD CONSTRAINT staff_department_same_organization_fkey
      FOREIGN KEY (department_id, organization_id)
      REFERENCES public.departments(id, organization_id)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE public.staff
  VALIDATE CONSTRAINT staff_department_same_organization_fkey;
CREATE INDEX IF NOT EXISTS idx_staff_organization_department
  ON public.staff (organization_id, department_id);

COMMIT;
