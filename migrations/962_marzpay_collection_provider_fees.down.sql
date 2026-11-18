BEGIN;

DROP TRIGGER IF EXISTS organizations_seed_marzpay_collection_fee ON public.organizations;
DROP FUNCTION IF EXISTS public.seed_marzpay_collection_fee_rule();

ALTER TABLE public.payment_intents
  DROP COLUMN provider_fee_minor;

COMMIT;
