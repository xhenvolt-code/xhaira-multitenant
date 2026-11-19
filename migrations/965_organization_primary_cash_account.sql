-- Migration 965: designate one tenant-scoped cash account for member money flows.
-- Apply only after a backup and staging rehearsal. This migration takes locks on
-- accounts while changing constraints/indexes; index creation scans accounts and
-- may block writes for the duration. If it fails, the transaction rolls back.
-- Forward recovery: inspect the failed statement and current catalog/data state,
-- then rerun only after resolving the reported inconsistency.

BEGIN;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS is_primary_cash_account BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.accounts
  DROP CONSTRAINT IF EXISTS accounts_primary_cash_account_check;

ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_primary_cash_account_check
  CHECK (
    NOT is_primary_cash_account
    OR (
      type::text = 'system'
      AND currency = 'UGX'
      AND is_active IS TRUE
      AND status = 'active'
    )
  ) NOT VALID;

ALTER TABLE public.accounts
  VALIDATE CONSTRAINT accounts_primary_cash_account_check;

DROP INDEX IF EXISTS public.uq_accounts_system_name;

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_org_system_name_active
  ON public.accounts (organization_id, name)
  WHERE type::text = 'system' AND is_active IS TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_one_primary_cash_per_org
  ON public.accounts (organization_id)
  WHERE is_primary_cash_account IS TRUE;

DO $$
DECLARE
  target_organization_id UUID := 'b6d28266-756f-4760-acc8-f4ebf5b995a4';
  account_record RECORD;
  existing_primary_id UUID;
BEGIN
  PERFORM set_config('app.organization_id', target_organization_id::TEXT, TRUE);

  IF NOT EXISTS (
    SELECT 1
      FROM public.organizations
     WHERE id = target_organization_id
  ) THEN
    RAISE EXCEPTION 'BUGADDE organization % does not exist', target_organization_id;
  END IF;

  SELECT id, currency, is_active, status
    INTO account_record
    FROM public.accounts
   WHERE organization_id = target_organization_id
   ORDER BY created_at ASC NULLS LAST, id ASC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BUGADDE has no account to promote; no account or balance was created';
  END IF;

  IF account_record.currency IS DISTINCT FROM 'UGX'
     OR account_record.is_active IS DISTINCT FROM TRUE
     OR account_record.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'BUGADDE earliest account % is not an active UGX account (currency %, is_active %, status %); inspect manually',
      account_record.id, account_record.currency, account_record.is_active, account_record.status;
  END IF;

  SELECT id
    INTO existing_primary_id
    FROM public.accounts
   WHERE organization_id = target_organization_id
     AND is_primary_cash_account IS TRUE
   LIMIT 1
   FOR UPDATE;

  IF existing_primary_id IS NOT NULL AND existing_primary_id <> account_record.id THEN
    RAISE EXCEPTION
      'BUGADDE already has a different primary cash account %; inspect before migration',
      existing_primary_id;
  END IF;

  UPDATE public.accounts
     SET type = 'system',
         is_primary_cash_account = TRUE,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = account_record.id
     AND organization_id = target_organization_id
     AND currency = 'UGX'
     AND is_active IS TRUE
     AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BUGADDE earliest account changed during promotion; no account was promoted';
  END IF;
END;
$$;

COMMIT;
