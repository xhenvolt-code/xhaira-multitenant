BEGIN;

ALTER TABLE public.payment_intents
  ADD COLUMN provider_amount_minor BIGINT
    CHECK (provider_amount_minor IS NULL OR provider_amount_minor >= 0),
  ADD COLUMN provider_currency VARCHAR(16),
  ADD COLUMN provider_mode VARCHAR(32),
  ADD COLUMN ledger_amount_minor BIGINT
    CHECK (ledger_amount_minor IS NULL OR ledger_amount_minor >= 0);

COMMIT;
