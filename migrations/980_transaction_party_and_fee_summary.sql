BEGIN;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS depositor_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS receiver_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS principal_minor BIGINT CHECK (principal_minor IS NULL OR principal_minor >= 0),
  ADD COLUMN IF NOT EXISTS transaction_charges_minor BIGINT
    CHECK (transaction_charges_minor IS NULL OR transaction_charges_minor >= 0);

-- Financial transactions are immutable in this database. Do not update historical
-- rows to backfill these fields; readers retain metadata fallbacks for old records.
-- New transaction inserts populate the columns directly.

COMMIT;
