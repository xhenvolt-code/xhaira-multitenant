-- Align the live ledger source_type constraint with the canonical ledger
-- migration. The preflight prevents replacing the constraint if this database
-- contains a source type that is not part of the application's known set.
BEGIN;

DO $$
DECLARE
  unsupported_types TEXT;
BEGIN
  IF to_regclass('public.ledger') IS NULL THEN
    RAISE EXCEPTION 'public.ledger is missing; refusing to alter ledger source types';
  END IF;

  SELECT string_agg(DISTINCT source_type, ', ' ORDER BY source_type)
    INTO unsupported_types
    FROM public.ledger
   WHERE source_type NOT IN (
     'payment', 'expense', 'transfer_in', 'transfer_out', 'adjustment',
     'refund', 'initial_balance', 'loan_disbursement', 'loan_repayment',
     'deposit', 'withdrawal', 'fee'
   );

  IF unsupported_types IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected ledger source_type values found (%); inspect current constraint and data before proceeding', unsupported_types;
  END IF;
END
$$;

ALTER TABLE public.ledger
  DROP CONSTRAINT IF EXISTS ledger_source_type_check;

ALTER TABLE public.ledger
  ADD CONSTRAINT ledger_source_type_check
  CHECK (source_type IN (
    'payment', 'expense', 'transfer_in', 'transfer_out', 'adjustment',
    'refund', 'initial_balance', 'loan_disbursement', 'loan_repayment',
    'deposit', 'withdrawal', 'fee'
  ));

COMMIT;
