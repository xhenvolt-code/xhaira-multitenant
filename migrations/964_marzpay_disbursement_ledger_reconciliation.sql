BEGIN;

ALTER TABLE public.payment_intents
  ADD COLUMN IF NOT EXISTS ledger_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reconciliation_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reconciliation_error VARCHAR(255),
  ADD COLUMN IF NOT EXISTS reconciliation_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_adjustment_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS ledger_failure_reason VARCHAR(255),
  ADD COLUMN IF NOT EXISTS provider_fee_confirmed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.payment_intents
  DROP CONSTRAINT IF EXISTS payment_intents_ledger_status_check,
  DROP CONSTRAINT IF EXISTS payment_intents_reconciliation_status_check;

ALTER TABLE public.payment_intents
  ADD CONSTRAINT payment_intents_ledger_status_check
    CHECK (ledger_status IN ('pending', 'posted', 'failed')),
  ADD CONSTRAINT payment_intents_reconciliation_status_check
    CHECK (reconciliation_status IN ('pending', 'matched', 'adjusted', 'review'));

DO $$
DECLARE
  allowed_account_types TEXT[];
BEGIN
  SELECT array_agg(DISTINCT allowed_type ORDER BY allowed_type)
    INTO allowed_account_types
    FROM (
      SELECT type AS allowed_type FROM public.accounts
      UNION ALL
      SELECT unnest(ARRAY['bank', 'cash', 'mobile_money', 'credit_card', 'investment',
                          'escrow', 'savings', 'internal', 'salary', 'system', 'other']::TEXT[])
    ) types;

  ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
  EXECUTE format(
    'ALTER TABLE public.accounts ADD CONSTRAINT accounts_type_check CHECK (type::text = ANY (%L::text[]))',
    allowed_account_types
  );
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.payment_intents'::regclass
       AND conname = 'payment_intents_reconciliation_adjustment_transaction_fkey'
  ) THEN
    ALTER TABLE public.payment_intents
      ADD CONSTRAINT payment_intents_reconciliation_adjustment_transaction_fkey
      FOREIGN KEY (organization_id, reconciliation_adjustment_transaction_id)
      REFERENCES public.transactions (organization_id, id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

UPDATE public.payment_intents pi
   SET ledger_status = 'posted',
       ledger_amount_minor = pi.amount_minor
 WHERE pi.direction = 'disbursement'
   AND pi.transaction_id IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM public.ledger_entries le
      WHERE le.transaction_id = pi.transaction_id
        AND le.member_account_id = pi.member_account_id
        AND le.entry_type = 'DEBIT'
        AND le.amount = pi.amount_minor
   );

INSERT INTO public.accounts
  (organization_id, name, type, currency, description, is_active, status)
SELECT o.id, 'MarzPay Reconciliation Suspense', 'system', 'UGX',
       'Per-organization contra account for verified MarzPay payout variances',
       TRUE, 'active'
  FROM public.organizations o
 WHERE NOT EXISTS (
   SELECT 1
     FROM public.accounts a
    WHERE a.organization_id = o.id
      AND a.name = 'MarzPay Reconciliation Suspense'
      AND a.currency = 'UGX'
  );

INSERT INTO public.sacco_configurations
  (organization_id, config_key, config_value, config_type, category, label, description)
SELECT a.organization_id, 'payments.marzpay.reconciliation_account_id',
       to_jsonb(a.id::TEXT), 'text', 'accounts',
       'MarzPay reconciliation account',
       'UGX organization system account used as the contra for verified MarzPay payout variances.'
  FROM public.accounts a
 WHERE a.name = 'MarzPay Reconciliation Suspense'
   AND a.type = 'system'
   AND a.currency = 'UGX'
   AND a.is_active = TRUE
   AND a.status = 'active'
ON CONFLICT (organization_id, config_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_payment_intents_disbursement_reconciliation
  ON public.payment_intents (organization_id, direction, reconciliation_status, created_at)
  WHERE direction = 'disbursement';

COMMIT;
