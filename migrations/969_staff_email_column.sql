-- Migration 969: add the staff email column expected by current staff/RBAC endpoints.
-- This is additive and does not backfill or reassign existing staff records.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.staff') IS NULL THEN
    RAISE EXCEPTION 'public.staff is missing; apply the reviewed core schema before this migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'staff' AND column_name = 'organization_id'
  ) THEN
    RAISE EXCEPTION 'public.staff has no organization_id; refusing to alter a non-tenant staff table';
  END IF;
END $$;

ALTER TABLE public.staff ADD COLUMN IF NOT EXISTS email VARCHAR(255);

COMMIT;
