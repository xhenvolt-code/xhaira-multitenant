BEGIN;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS depositor_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS receiver_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS principal_minor BIGINT CHECK (principal_minor IS NULL OR principal_minor >= 0),
  ADD COLUMN IF NOT EXISTS transaction_charges_minor BIGINT
    CHECK (transaction_charges_minor IS NULL OR transaction_charges_minor >= 0);

-- Backfill the descriptive fields from the existing metadata contract. Existing
-- financial entries and historical transaction amounts are not changed.
UPDATE public.transactions
   SET reason = COALESCE(reason, NULLIF(metadata->>'reason', '')),
       depositor_name = COALESCE(depositor_name, NULLIF(metadata->>'depositor_name', ''), NULLIF(metadata->>'paid_by', '')),
       receiver_name = COALESCE(receiver_name, NULLIF(metadata->>'receiver_name', ''), NULLIF(metadata->>'withdrawn_to', ''))
 WHERE reason IS NULL OR depositor_name IS NULL OR receiver_name IS NULL;

COMMIT;
