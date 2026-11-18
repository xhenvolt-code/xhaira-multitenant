BEGIN;

ALTER TABLE public.payment_intents
  DROP COLUMN ledger_amount_minor,
  DROP COLUMN provider_mode,
  DROP COLUMN provider_currency,
  DROP COLUMN provider_amount_minor;

COMMIT;
