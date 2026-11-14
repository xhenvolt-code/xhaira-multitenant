BEGIN;

-- MarzPay send-money flows share the payment_intents lifecycle with collections.
ALTER TABLE public.payment_intents
  DROP CONSTRAINT IF EXISTS payment_intents_direction_check;

ALTER TABLE public.payment_intents
  ADD CONSTRAINT payment_intents_direction_check
  CHECK (direction IN ('collection', 'disbursement'));

COMMIT;
