-- Idempotency protection for organization-owned account deposits/withdrawals.
-- This migration preserves existing rows and does not touch financial balances.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.transactions') IS NULL
     OR to_regclass('public.ledger') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'transactions'
          AND column_name = 'organization_id'
     )
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'transactions'
          AND column_name = 'metadata' AND udt_name = 'jsonb'
     ) THEN
    RAISE EXCEPTION 'Tenant-scoped transactions with JSONB metadata are required';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_org_idempotency
  ON public.transactions (organization_id, (metadata->>'idempotency_key'))
  WHERE metadata ? 'idempotency_key';

COMMIT;
