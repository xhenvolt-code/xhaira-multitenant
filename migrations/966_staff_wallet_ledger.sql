-- Add immutable ledger support for staff wallets and idempotent internal payroll credits.
-- Apply only after a production backup and a staging rehearsal. Adding the ledger
-- reference column and indexes scans existing tables and may hold locks; schedule
-- during a low-traffic window. Existing employee_accounts.balance values are left
-- untouched and are not used as a balance source. Forward recovery: inspect catalog
-- state and constraints, then rerun the idempotent DDL after correcting conflicts.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_accounts_organization_id_id
  ON public.employee_accounts (organization_id, id);

ALTER TABLE public.ledger_entries
  ADD COLUMN IF NOT EXISTS employee_account_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.ledger_entries'::regclass
       AND conname = 'ledger_entries_employee_account_org_fkey'
  ) THEN
    ALTER TABLE public.ledger_entries
      ADD CONSTRAINT ledger_entries_employee_account_org_fkey
      FOREIGN KEY (organization_id, employee_account_id)
      REFERENCES public.employee_accounts (organization_id, id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_ledger_entries_employee_account
  ON public.ledger_entries (organization_id, employee_account_id)
  WHERE employee_account_id IS NOT NULL;

ALTER TABLE public.payouts
  ADD COLUMN IF NOT EXISTS ledger_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.payouts'::regclass
       AND conname = 'payouts_ledger_transaction_org_fkey'
  ) THEN
    ALTER TABLE public.payouts
      ADD CONSTRAINT payouts_ledger_transaction_org_fkey
      FOREIGN KEY (organization_id, ledger_transaction_id)
      REFERENCES public.transactions (organization_id, id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_organization_idempotency_key
  ON public.payouts (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
